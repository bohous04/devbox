import type { NotifyExtra } from "./agentEvents";
import { httpError, permanentError, sendWithRetry } from "./sendRetry";
import { parseGrantDuration, type SshApprovalRow } from "./sshApprovals";

export interface SshApprovalAnswer {
  decision: "approve" | "deny";
  grantMinutes: number;
  grantPermanent?: true;
}

/** Ignore malformed answers, including ambiguous permanent/timed choices. */
function parseSshApprovalAnswer(body: unknown): SshApprovalAnswer | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const decision = (body as Record<string, unknown>).decision;
  if (decision !== "approve" && decision !== "deny") return null;
  if (decision === "deny") return { decision, grantMinutes: 0 };
  const duration = parseGrantDuration(body);
  if (!duration) return null;
  return { decision, grantMinutes: duration.grantMinutes,
    ...(duration.grantPermanent ? { grantPermanent: true as const } : {}) };
}

export interface ClipboardResult { status: number; contentType: string | null; filename?: string; body: Uint8Array }

export interface ListenerClient {
  open(hostPath: string): Promise<void>;
  openUrl(url: string): Promise<void>;
  notify(title: string, message: string, extra?: NotifyExtra): void;
  clipboard(kind: string): Promise<ClipboardResult>;
  /** Tell the Mac to open 127.0.0.1:1455 for `ttlSec` and forward the proxy login's OAuth
   *  callback to this devd's relay (`/api/auth/proxy/relay`, port `relayPort`).
   *  The listener derives the host from the source address of this request. */
  proxyBridge(ttlSec: number, relayPort: number): Promise<void>;
  /** Shows a blocking dialog on the Mac and writes the decision straight via `decide`.
   *  Failed delivery is fail-closed: the request simply stays pending. */
  /** `shared` = the request came from a shared/tainted session — the dialog must say so. */
  sshApproval(row: SshApprovalRow & { shared?: boolean }, decide: (d: SshApprovalAnswer) => void): Promise<void>;
  dbRequest(row: { id: number; wanted: string; why: string; project: string | null; session: string | null; shared?: boolean }, decide: (d: { decision: "deny" }) => void): Promise<void>;
}

export function createListenerClient(url: string | undefined, token: string | undefined, timeoutMs = 3000): ListenerClient {
  const base = url?.replace(/\/+$/, "");
  const post = async (path: string, body: unknown, tmo = timeoutMs): Promise<void> => {
    // Missing configuration and 4xx are both marked as PERMANENT — retrying them is pointless
    // and notify would keep bringing them back into the log for eight minutes (see sendRetry.ts).
    if (!base || !token) throw permanentError("listener is not configured (DEVD_LISTENER_URL / secrets.listenerToken)");
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(tmo),
    });
    if (!res.ok) throw httpError(res.status, `listener returned ${res.status}`);
  };
  return {
    // /open blocks the listener for the duration of `open` on the Mac (spawnSync) — an app cold launch
    // easily takes 3–10 s, so we give a longer cap than notify (otherwise a spurious 502 even though the
    // file opens; see DEVBOX-10).
    open: (hostPath) => post("/open", { path: hostPath }, 12_000),
    // the same longer cap as /open — browser cold launch on the Mac
    openUrl: (url) => post("/open-url", { url }, 12_000),
    proxyBridge: (ttlSec, relayPort) => post("/proxy-bridge", { ttlSec, relayPort }),
    // The only path in this client that nobody waits for and nobody requests
    // again — that is why it is the only one that retries. `open`/`clipboard` have a person behind them
    // who will press it again; a dropped notification never comes back (see sendRetry.ts).
    notify(title, message, extra) {
      void sendWithRetry("listener notify", () => post("/notify", {
        title, message,
        ...(extra?.sound ? { sound: true } : {}),
        ...(extra?.session ? { session: extra.session } : {}),
      }));
    },
    async sshApproval(row, decide) {
      if (!base || !token) return;                       // Mac not configured → other surfaces
      try {
        const res = await fetch(`${base}/ssh-approval`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify({
            id: row.id, title: row.title, why: row.why, target: row.target, server: row.server,
            cwd: row.cwd, project: row.project, repo: row.repo,
            ...(row.shared ? { shared: true } : {}),
          }),
          // The dialog closes itself after 85 s — the HTTP cap is just a hair longer.
          signal: AbortSignal.timeout(90_000),
        });
        if (res.status === 200) {
          const ans = parseSshApprovalAnswer(await res.json().catch(() => null));
          if (ans) decide(ans);
        }
      } catch { /* Mac unreachable → decided from the phone or the dashboard */ }
    },
    async dbRequest(row, decide) {
      if (!base || !token) return;                       // Mac not configured → dashboard
      try {
        const res = await fetch(`${base}/db-request`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify(row),
          signal: AbortSignal.timeout(90_000),
        });
        if (res.status !== 200) return;
        const ans = (await res.json().catch(() => null)) as { decision?: string } | null;
        // Only a denial changes anything; the Mac handles "Open" itself by opening the dashboard.
        if (ans?.decision === "deny") decide({ decision: "deny" });
      } catch { /* Mac unreachable → decided in the dashboard */ }
    },
    async clipboard(kind) {
      if (!base || !token) throw new Error("listener is not configured (DEVD_LISTENER_URL / secrets.listenerToken)");
      // A large PNG (fullscreen Retina) needs more than the 3 s notify/open budget;
      // the file also travels over the tailnet, so it has its own more generous cap.
      const tmo = kind === "file" ? 60_000 : Math.max(timeoutMs, 12_000);
      const res = await fetch(`${base}/clipboard/${kind}`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(tmo),
      });
      const fn = res.headers.get("x-devbox-filename");
      return {
        status: res.status,
        contentType: res.headers.get("content-type"),
        filename: fn ? decodeURIComponent(fn) : undefined,
        body: new Uint8Array(await res.arrayBuffer()),
      };
    },
  };
}
