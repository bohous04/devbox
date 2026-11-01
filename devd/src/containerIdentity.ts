// The container of a SHARED session may reach on :4300 only what the agent in the container actually calls,
// and only on behalf of its own session. The host of a shared terminal can type in it, so everything the
// container can reach is available to them too — and the devd API is otherwise open from the docker bridge
// (the terminal of any session, config, approvals…). Unshared sessions are unchanged.
//
// The container identity IS the source IP of the request (a map from `docker inspect`), never the
// `x-devbox-session` header — the container can write whatever it wants there, so it is only COMPARED.
import type { Database } from "bun:sqlite";
import type { Context, MiddlewareHandler } from "hono";
import { listSessions } from "./db";
import { dindName } from "./dind";
import { parseOtlpMetrics } from "./metrics";
import { isAddressInCidr, isApprovalAllowed, isInstaboxAddress } from "./network";
import { run, timeoutFor, type RunOpts, type RunResult } from "./proc";
import { isTainted, sessionsWithTaint } from "./shareTaint";
import { listActiveShares, onShareRevoked } from "./shares";
import { getApproval } from "./sshApprovals";

export const SHARED_DENIED = "session is shared — access restricted";

/* ------------------------------ IP → session ------------------------------ */

/** `::ffff:172.18.0.5` (IPv4 over a dual-stack socket) → `172.18.0.5`. */
const normalizeIp = (ip: string) => ip.trim().replace(/^::ffff:/i, "");

/** Result of one `docker inspect`: IP → session and session → docker id of its container
 *  (for taint, shareTaint.ts). The older shape = just the IP map. */
export interface ContainerSnapshot { ips: Map<string, string>; containerIds: Map<string, string> }

export interface ContainerIdentityDeps {
  /** Current map of container IP → session id (in production `dockerContainerSnapshot`). */
  snapshot?: () => Promise<Map<string, string> | ContainerSnapshot>;
  /** Called after every successful inspect (index.ts cleans up taint rows of rebuilt containers here). */
  onSnapshot?: (s: ContainerSnapshot) => void;
  now?: () => number;
  /** Safety cap on map age, in case a docker event is lost (default 60 s). */
  maxAgeMs?: number;
  /** Minimum spacing of forced inspects (`fresh`, only on denial), default 10 s —
   *  so the host of a shared terminal cannot keep docker busy with repeated denials. */
  minIntervalMs?: number;
}

/** The map is refreshed when it is stale (`markChanged` after a container start/recreate, or
 *  maxAge), otherwise it is authoritative: an unknown IP on a fresh map is not a session container
 *  and no further inspect is started because of it. Concurrent queries share one running inspect. */
export class ContainerIdentity {
  private map = new Map<string, string>();
  private ids: Map<string, string> | null = null; // null = the snapshot carries no docker id
  /** Grows with every successful inspect — SharedSessions recomputes taint based on it. */
  generation = 0;
  private at = -Infinity; // when the last successful inspect started
  private stale = true;
  private inflight: Promise<void> | null = null;

  constructor(private d: ContainerIdentityDeps = {}) {}

  configure(d: ContainerIdentityDeps): void { this.d = d; this.markChanged(); }

  /** A container (session or dind sidecar) started / connected to a network — IPs may have shuffled. */
  markChanged(): void { this.stale = true; }

  /** Has at least one successful inspect happened? Without it the map says nothing and the middleware
   *  must reject callers from the docker bridge while sharing is active (fail-closed). */
  get ready(): boolean { return this.at !== -Infinity; }

  /** Docker id of the session's container from the last inspect; undefined = unknown (inspect
   *  did not run, the container does not exist, or the snapshot carries no id). */
  containerIdFor(session: string): string | undefined {
    return this.ids?.get(session);
  }

  /** IPs of the session's containers (including its sidecar) from the last known map. */
  ipsFor(session: string): string[] {
    return [...this.map].filter(([, s]) => s === session).map(([ip]) => ip);
  }

  /** Refreshes the map if stale (markChanged / maxAge) — without forcing. */
  async refreshIfStale(): Promise<void> {
    if (!this.d.snapshot) return;
    if (this.stale || this.now() - this.at > (this.d.maxAgeMs ?? 60_000)) await this.refresh();
  }

  /** Synchronous view into the last known map. */
  sessionForSourceIp(ip: string): string | null {
    return this.map.get(normalizeIp(ip)) ?? null;
  }

  /** Session of the container the request came from. `fresh` = verify against a fresh
   *  inspect (with minIntervalMs spacing) — in case the cache holds an IP that another container
   *  received in the meantime. */
  async identify(ip: string, opts: { fresh?: boolean } = {}): Promise<string | null> {
    if (this.d.snapshot) {
      const now = this.now();
      const old = this.stale || now - this.at > (this.d.maxAgeMs ?? 60_000);
      const forced = opts.fresh && now - this.at >= (this.d.minIntervalMs ?? 10_000);
      if (old || forced) await this.refresh();
    }
    return this.sessionForSourceIp(ip);
  }

  private now(): number { return (this.d.now ?? Date.now)(); }

  private refresh(): Promise<void> {
    if (this.inflight) return this.inflight;
    const snapshot = this.d.snapshot!;
    const startedAt = this.now();
    this.stale = false; // an event during the inspect sets stale again → the next query refreshes
    this.inflight = snapshot().then(
      (snap) => {
        const s: ContainerSnapshot = snap instanceof Map ? { ips: snap, containerIds: new Map() } : snap;
        this.map = s.ips; this.ids = snap instanceof Map ? null : s.containerIds; this.at = startedAt; this.generation++;
        try { this.d.onSnapshot?.(s); } catch (e) { console.warn(`containerIdentity: onSnapshot failed — ${(e as Error).message}`); }
      },
      (e) => { this.stale = true; console.warn(`containerIdentity: docker inspect failed — ${(e as Error).message}`); },
    ).finally(() => { this.inflight = null; });
    return this.inflight;
  }
}

/** Default instance for the devd process; index.ts gives it `snapshot` and reports docker events. */
export const containerIdentity = new ContainerIdentity();

export function sessionForSourceIp(ip: string): string | null {
  return containerIdentity.sessionForSourceIp(ip);
}

/** IPs of all running VPS session containers and their dind sidecars (containers the
 *  agent launches in dind go out via the sidecar's IP). InstaBox sessions go to :4301 over the
 *  tailnet and cannot be shared — left out. One `docker inspect` for all names; missing
 *  (stopped) containers are reported by docker on stderr with a nonzero code, the rest are printed. */
export async function dockerContainerIps(
  db: Database,
  exec: (cmd: string[], opts: RunOpts) => Promise<RunResult> = run,
): Promise<Map<string, string>> {
  return (await dockerContainerSnapshot(db, exec)).ips;
}

/** Like dockerContainerIps, plus the docker id of each session's container (not the sidecar) —
 *  even a stopped one: `docker inspect` returns stopped containers too, just without an IP. */
export async function dockerContainerSnapshot(
  db: Database,
  exec: (cmd: string[], opts: RunOpts) => Promise<RunResult> = run,
): Promise<ContainerSnapshot> {
  const byName = new Map<string, { session: string; main: boolean }>();
  for (const s of listSessions(db)) {
    if ((s.host ?? "vps") === "instabox") continue;
    byName.set(s.container, { session: s.id, main: true });
    byName.set(dindName(s.id), { session: s.id, main: false });
  }
  const ips = new Map<string, string>();
  const containerIds = new Map<string, string>();
  if (byName.size === 0) return { ips, containerIds };
  const r = await exec(["docker", "inspect", "--type", "container", "-f",
    "{{.Name}} {{.Id}} {{range .NetworkSettings.Networks}}{{.IPAddress}} {{.GlobalIPv6Address}} {{end}}", ...byName.keys()],
  { timeoutMs: timeoutFor("DOCKER_QUERY") });
  if (r.timedOut) throw new Error("docker inspect timed out");
  for (const line of r.stdout.split("\n")) {
    const [name, id, ...rest] = line.trim().split(/\s+/);
    const who = name ? byName.get(name.replace(/^\//, "")) : undefined;
    if (!who) continue;
    if (who.main && id) containerIds.set(who.session, id);
    for (const ip of rest) if (ip) ips.set(ip, who.session);
  }
  if (containerIds.size === 0 && ips.size === 0 && r.code !== 0 && !/No such container/i.test(r.stderr)) throw new Error(r.stderr.trim() || `docker inspect exited with code ${r.code}`);
  return { ips, containerIds };
}

/** Watches `docker events` (container start, network connect) — exactly the moments when
 *  IPs may shuffle, including restarts via `--restart unless-stopped` that
 *  SessionManager does not know about. If the stream dies (docker restart) → it is restarted after 5 s and the map
 *  is marked stale just in case. Returns a function that stops the watching. */
type EventsProc = { stdout: ReadableStream<Uint8Array>; exited: Promise<unknown>; kill(): void };
export function watchDockerEvents(
  onChange: () => void,
  spawn: (cmd: string[]) => EventsProc = (cmd) => Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore", stdin: "ignore" }) as unknown as EventsProc,
  retryMs = 5_000,
): () => void {
  let stopped = false;
  let proc: EventsProc | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const start = () => {
    if (stopped) return;
    try {
      proc = spawn(["docker", "events", "--format", "{{.Type}} {{.Action}}",
        "--filter", "type=container", "--filter", "type=network",
        "--filter", "event=start", "--filter", "event=connect"]);
    } catch (e) {
      console.warn(`containerIdentity: docker events cannot be started — ${(e as Error).message}`);
      timer = setTimeout(start, retryMs);
      return;
    }
    // Whatever started before the stream was running (devd start, docker outage) would otherwise not be
    // covered by any event — so the map is marked stale after every (re)spawn.
    onChange();
    const p = proc;
    void (async () => {
      const reader = p.stdout.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value?.length) onChange();
        }
      } catch { /* the stream ended */ }
      await p.exited;
      onChange();
      if (!stopped) timer = setTimeout(start, retryMs);
    })();
  };
  start();
  return () => { stopped = true; if (timer) clearTimeout(timer); proc?.kill(); };
}

/* ------------------------------ allowlist ------------------------------ */

/** `session`: "required" = the route works with a session (identifies it by body, header
 *  or query) and it MUST be the caller; "none" = the route does not need a session (any
 *  given one must still be the caller). Each entry = what image/ actually calls:
 *  hooks (vendor/devd-hooks/devd-hook.sh), OTel (OTEL_EXPORTER_OTLP_ENDPOINT), preview,
 *  srv (op/ssh-keys, ssh-approvals), entrypoint (git proxy insteadOf),
 *  prod-db + db-request, account-lease.sh,
 *  codex-account-env.sh (Codex account selection) and the availability check (/api/health).
 *  DELIBERATELY missing: the clipboard (/api/clipboard/*, xclip/devbox-ctrlv) — the host would read the owner's
 *  mac clipboard — /api/notify (the host would send notifications to the owner) and /api/open
 *  (the host would write `x.command`/`.app` onto the SMB share and have the owner's mac open it). */
const RULES: { methods: readonly string[]; re: RegExp; session: "required" | "none" }[] = [
  { methods: ["GET", "HEAD"], re: /^\/api\/health$/, session: "none" },
  { methods: ["POST"], re: /^\/api\/agent-event$/, session: "required" },
  { methods: ["POST"], re: /^\/v1\/metrics$/, session: "none" },
  { methods: ["POST"], re: /^\/api\/preview$/, session: "required" },
  { methods: ["GET"], re: /^\/api\/op\/ssh-keys$/, session: "required" },
  { methods: ["POST"], re: /^\/api\/ssh-approvals$/, session: "required" },
  { methods: ["GET"], re: /^\/api\/ssh-approvals\/[A-Za-z0-9-]+$/, session: "required" },
  { methods: ["POST"], re: /^\/api\/ssh-approvals\/[A-Za-z0-9-]+\/activate$/, session: "required" },
  { methods: ["GET"], re: /^\/api\/prod-db\/catalog$/, session: "required" },
  { methods: ["GET"], re: /^\/api\/prod-db\/[a-z_][a-z0-9_]{0,62}\/url$/, session: "required" },
  { methods: ["POST"], re: /^\/api\/prod-db\/[a-z_][a-z0-9_]{0,62}\/write$/, session: "required" },
  { methods: ["GET"], re: /^\/api\/prod-db\/writes\/[1-9][0-9]*$/, session: "required" },
  { methods: ["POST"], re: /^\/api\/prod-db\/requests$/, session: "required" },
  { methods: ["GET"], re: /^\/api\/prod-db\/requests\/[1-9][0-9]*$/, session: "required" },
  { methods: ["POST"], re: /^\/api\/prod-db\/requests\/[1-9][0-9]*\/(prepare|resume)$/, session: "required" },
  { methods: ["GET"], re: /^\/api\/accounts\/lease$/, session: "required" },
  { methods: ["GET"], re: /^\/api\/codex-accounts\/select$/, session: "none" },
  // Git proxy: the token placeholder in Basic auth is per-session (git_placeholders) — claimedSessions
  // translates it to a session, and that must be the caller. Git's first request goes without auth (401 challenge).
  { methods: ["GET", "HEAD", "POST"], re: /^\/git\/[^/]+\/.+$/, session: "none" },
];

/** May the container of shared session `callerSession` call this route? `targetSession` =
 *  the session the request acts for (from body / header / query / DB row); null =
 *  the request names none. */
export function sharedContainerAllowed(method: string, path: string, callerSession: string, targetSession: string | null): boolean {
  // Encoded dots/slashes and `..` could give two different readings of the path (like vmListener).
  if (/%(2e|2f|5c)/i.test(path) || path.includes("\\") || path.split("/").some((seg) => seg === ".." || seg === ".")) return false;
  const rule = RULES.find((r) => r.re.test(path) && r.methods.includes(method.toUpperCase()));
  if (!rule) return false;
  if (targetSession === null) return rule.session === "none";
  return targetSession === callerSession;
}

/* ------------------------------ middleware ------------------------------ */

/** The set of RESTRICTED sessions — with active sharing OR tainted (the container was
 *  shared and has not been rebuilt yet, shareTaint.ts) — cached, the middleware asks on
 *  every request from the docker bridge. Valid until the nearest expiry (max 5 s); creating one
 *  (`invalidate` from the route) drops it immediately. Revoking/expiry of sharing does NOT lift the restriction —
 *  only a container rebuild can (final review C4). */
// A single subscription to onShareRevoked for the whole process (not one per instance — instances
// have no lifecycle, listeners would pile up in tests): a revoke only bumps the epoch.
let revokeEpoch = 0;
onShareRevoked(() => { revokeEpoch++; });

export class SharedSessions {
  private set: Set<string> | null = null;
  private activeSet: Set<string> = new Set();
  private validUntil = 0;
  private epoch = revokeEpoch;
  private generation = -1;
  constructor(private db: Database, private now: () => number = Date.now, private identity?: ContainerIdentity) {}
  invalidate(): void { this.set = null; }
  /** Shared and tainted sessions — both have the same restrictions. */
  current(): Set<string> {
    const now = this.now();
    const gen = this.identity?.generation ?? 0;
    if (!this.set || now >= this.validUntil || this.epoch !== revokeEpoch || this.generation !== gen) {
      this.epoch = revokeEpoch;
      this.generation = gen;
      const rows = listActiveShares(this.db, now);
      this.activeSet = new Set(rows.map((r) => r.session_id));
      const set = new Set(this.activeSet);
      for (const sid of sessionsWithTaint(this.db)) {
        if (this.tainted(sid)) set.add(sid);
      }
      this.set = set;
      this.validUntil = Math.min(now + 5_000, ...rows.map((r) => r.expires_at));
    }
    return this.set;
  }
  /** Only sessions with active (not revoked, not expired) sharing. */
  active(): Set<string> { this.current(); return this.activeSet; }
  /** Tainted session according to the last known container map (unknown id → fail-closed). */
  tainted(sessionId: string): boolean {
    const row = this.db.query("SELECT container FROM sessions WHERE id=?").get(sessionId) as { container: string } | null;
    // Session without a row: the container no longer belongs to anything that could be restricted.
    if (!row) return false;
    return isTainted(this.db, sessionId, this.identity?.containerIdFor(sessionId));
  }
}

const JSON_BODY_SESSION = /^\/api\/(agent-event|preview|open|ssh-approvals)$/;
const APPROVAL_ID = /^\/api\/ssh-approvals\/([A-Za-z0-9-]+)(\/activate)?$/;

/** All sessions the request claims to act for — each must be the caller. */
async function claimedSessions(c: Context, db: Database): Promise<string[]> {
  const claims: string[] = [];
  const add = (v: unknown) => { if (typeof v === "string" && v.trim()) claims.push(v.trim()); };
  add(c.req.header("x-devbox-session"));
  add(c.req.query("session"));
  const path = c.req.path, post = c.req.method === "POST";
  if (post && JSON_BODY_SESSION.test(path)) {
    // c.req.json() caches the body — the route handler reads it again unchanged.
    const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
    add(body?.sessionId); add(body?.session);
  }
  if (post && path === "/v1/metrics") {
    try {
      for (const p of parseOtlpMetrics(await c.req.json())) add(p.attributes["devbox.session.id"]);
    } catch { /* the handler discards unreadable metrics anyway (accepted: 0) */ }
  }
  if (path.startsWith("/git/")) {
    const auth = c.req.header("authorization") ?? "";
    let password = "";
    if (auth.startsWith("Basic ")) { try { password = atob(auth.slice(6)).split(":").slice(1).join(":"); } catch { /* invalid base64 */ } }
    if (password) {
      const row = db.query("SELECT session_id FROM git_placeholders WHERE placeholder = ?").get(password) as { session_id: string } | null;
      // An unknown placeholder is rejected by the git proxy itself (403); here it is only about a foreign session.
      if (row) claims.push(row.session_id);
    }
  }
  const approval = APPROVAL_ID.exec(path);
  if (approval) {
    const row = getApproval(db, approval[1]!);
    if (row) claims.push(row.session_id ?? "(no session)");
  }
  return claims;
}

/** A container that is not in the map (C1): the host of a shared terminal can, via a privileged
 *  container, assign itself a free IP on the docker network and try it "from outside the map". While
 *  some session is restricted, an unknown address gets the same rights as a shared session without
 *  its own identity — i.e. only routes not tied to a session and nothing that acts on behalf of a session. */
const UNKNOWN_CALLER = "\u0000unknown-container";

export interface SharedGuardDeps {
  db: Database;
  remoteAddr?: (c: Context) => string | undefined;
  identity: ContainerIdentity;
  shared: SharedSessions;
  /** `DEVD_APPROVAL_ALLOW` — sources (the dashboard cloudflared tunnel etc.) that devd
   *  trusts the same as loopback/tailnet; they are not containers. */
  approvalAllowExtra?: readonly string[];
}

/** An address missing from the container map that is NOT unknown: an InstaBox machine (the VM calls via
 *  :4301 into the same app and will never be in the VPS docker container map) and sources
 *  from `DEVD_APPROVAL_ALLOW`. Before C1 such addresses passed (`!caller → next()`) and they must
 *  keep doing so — otherwise one shared/tainted session would lock hooks, SSH, prod-db and git proxy
 *  for all InstaBox sessions (rereview N2). A container the map DOES know is not overridden by this. */
function trustedNonContainer(addr: string, extra: readonly string[]): boolean {
  return isInstaboxAddress(addr) || extra.some((cidr) => isAddressInCidr(addr, cidr));
}

/** Middleware for the whole app (before the git proxy and /api routes). Loopback and tailnet
 *  (dashboard, mac, iOS, InstaBox VM on :4301) are not containers and pass straight on;
 *  without a restricted (shared / tainted) session nothing more is done. Otherwise fail-closed:
 *  a missing address or a container map not loaded yet → 403; an address that is not in the map
 *  (even after a fresh inspect) is treated as a restricted session (final review C1) —
 *  except InstaBox machines and sources from `DEVD_APPROVAL_ALLOW` (rereview N2);
 *  only a known container of an UNrestricted session passes. */
export function sharedContainerGuard(d: SharedGuardDeps): MiddlewareHandler {
  return async (c, next) => {
    const addr = d.remoteAddr?.(c);
    if (addr && isApprovalAllowed(addr)) return next();
    const shared = d.shared.current();
    if (shared.size === 0) return next();
    if (!addr) return c.json({ error: SHARED_DENIED }, 403);
    for (const fresh of [false, true]) {
      const known = await d.identity.identify(addr, { fresh });
      if (!d.identity.ready) return c.json({ error: SHARED_DENIED }, 403);
      if (known && !shared.has(known)) return next();
      if (!known && trustedNonContainer(addr, d.approvalAllowExtra ?? [])) return next();
      const caller = known ?? UNKNOWN_CALLER;
      const claims = await claimedSessions(c, d.db);
      const target = claims.find((s) => s !== caller) ?? (claims.length ? caller : null);
      if (sharedContainerAllowed(c.req.method, c.req.path, caller, target)) return next();
      // A denial is verified against a fresh map: another container may have received the cached IP meanwhile
      // (or it is a just-started container the map does not know yet).
    }
    return c.json({ error: SHARED_DENIED }, 403);
  };
}
