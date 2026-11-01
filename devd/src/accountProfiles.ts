// Account profiles (CLAUDE_CONFIG_DIR) live as docker volumes. devd runs on the host and
// can reach a volume only through a container — same pattern as codexAuth.ts / backup.ts.
// The docker call is injected (`run`) so it can be tested without a real docker.
//
// The profile split (what is own and what is a symlink) is known by a SINGLE file:
// image/link-shared-profile.sh. Both this module and the mac runbook call it, so the two
// sides cannot drift apart. The list of shared items is DELIBERATELY not repeated here.

export const PROFILE_ROOT = "/home/dev/.claude-accounts";
export const CLAUDE_VOLUME = "claude-home";
export const LINKER = "/usr/local/bin/link-shared-profile";
const DEFAULT_IMAGE = "devbox:latest";

// The id goes into the volume name and the mount path — hence a narrow whitelist, not sanitization.
export function isValidAccountId(id: string): boolean {
  return typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9-]{0,30}$/.test(id);
}

export function profileVolume(id: string): string { return `claude-acct-${id}`; }
export function profilePath(id: string): string { return `${PROFILE_ROOT}/${id}`; }
export function profileMount(id: string): string { return `${profileVolume(id)}:${profilePath(id)}`; }

/** Mounts of all profiles for the session container. An invalid id is silently dropped —
 *  a bad DB entry must not prevent a session from starting. */
export function accountMountList(ids: string[]): string[] {
  return ids.filter(isValidAccountId).map(profileMount);
}

export interface ProfileDeps {
  run: (cmd: string[], input?: string) => Promise<{ code: number; stdout: string; stderr: string }>;
  image?: string;
}

function img(d: ProfileDeps): string { return d.image ?? DEFAULT_IMAGE; }

function assertId(id: string): void {
  if (!isValidAccountId(id)) throw new Error(`invalid account id: ${id}`);
}

// Ephemeral containers run as ROOT (-u 0): a fresh named volume has a root:root
// mountpoint, so USER dev (uid 1000) could not write into it. Hence the chown at the end.
const AS_ROOT = ["-u", "0"];

/** Profile provisioning script. Runs in a container with `/profile` = the account volume and
 *  `/shared` = claude-home; it reads credentials from STDIN (not from argv — the token would
 *  be visible in `ps` and in `docker inspect`).
 *
 *  The profile split is done by the shared linker. The third argument is the path claude-home
 *  has IN THE SESSION CONTAINER — `/shared` exists only here and a link to it would be dead.
 *  The fourth argument is the `.claude.json` seed: in a devbox `/shared/.claude.json`
 *  USUALLY EXISTS — `tools/agent-sync.ts` writes `mcpServers` into it
 *  (`claude mcp add-json --scope user` writes to `$CLAUDE_CONFIG_DIR/.claude.json`,
 *  and agent-sync runs with the default `CLAUDE_CONFIG_DIR=/home/dev/.claude`, i.e. exactly
 *  on claude-home). So the seed is NOT a minor convenience — it is the only way a new
 *  profile gets MCP servers (playwright/visual-QA, plane, team-docs, …) without anyone
 *  setting them up by hand for each account (review round 4, I4 minor). Without a
 *  seed (a fresh devbox before the first agent-sync, or a deleted claude-home) the profile
 *  is created with `{}` — fine, the container has a single project `/workspace`, so the
 *  trust dialog appears at most once, just without MCP servers. On the mac, with 100+ projects,
 *  seeding is done by hand (runbook).
 *
 *  chown stays HERE, not in the linker: on the mac uid 1000 would be nonsense. */
export function provisionScript(): string {
  return `set -e
umask 077
mkdir -p /profile
cat > /profile/.credentials.json
${LINKER} /profile /shared /home/dev/.claude /shared/.claude.json
chown -R 1000:1000 /profile
chmod 700 /profile
chmod 600 /profile/.credentials.json`;
}

export async function provisionProfile(d: ProfileDeps, id: string, credentials: string): Promise<void> {
  assertId(id);
  const r = await d.run([
    "run", "--rm", "-i", ...AS_ROOT,
    "-v", `${profileVolume(id)}:/profile`,
    "-v", `${CLAUDE_VOLUME}:/shared`,
    img(d), "sh", "-c", provisionScript(),
  ], credentials);
  if (r.code !== 0) throw new Error(`provisioning profile ${id} failed: ${r.stderr.trim().slice(0, 300)}`);
}

/** Contents of .credentials.json, or null (profile missing / corrupted). */
export async function readProfileCredentials(d: ProfileDeps, id: string): Promise<string | null> {
  assertId(id);
  const r = await d.run([
    "run", "--rm", ...AS_ROOT, "-v", `${profileVolume(id)}:/profile`,
    img(d), "cat", "/profile/.credentials.json",
  ]);
  return r.code === 0 && r.stdout.trim() !== "" ? r.stdout : null;
}

/** Writes the refreshed blob back into the profile. The blob goes to STDIN, not argv. */
export async function writeProfileCredentials(d: ProfileDeps, id: string, blob: string): Promise<void> {
  assertId(id);
  const r = await d.run([
    "run", "--rm", "-i", ...AS_ROOT, "-v", `${profileVolume(id)}:/profile`,
    img(d), "sh", "-c",
    "umask 077; cat > /profile/.credentials.json; chown 1000:1000 /profile/.credentials.json",
  ], blob);
  if (r.code !== 0) throw new Error(`writing credentials to ${id} failed: ${r.stderr.trim().slice(0, 300)}`);
}

export interface ProfileIdentity {
  loggedIn: boolean; email: string | null; orgName: string | null; subscriptionType: string | null;
  // The account's stable organization ID. Neither name nor email fits: `orgName` is
  // free text ("user@example.com's Organization") and `email` from `auth status`
  // can be null. `orgId` is THE SAME string the
  // `anthropic-organization-id` header returns on /api/oauth/usage — which is why what the
  // profile CLAIMS at registration can be compared with what the API reports on every measurement.
  orgId: string | null;
}

const NO_IDENTITY: ProfileIdentity = { loggedIn: false, email: null, orgName: null, subscriptionType: null, orgId: null };

/** Tries to parse `text` as a JSON object with the `loggedIn` key; otherwise `null`.
 *  The `loggedIn` key is a deliberate requirement — otherwise a piece of noise that happens
 *  to be valid JSON (say `{}` or a number) would pass as an identity. */
function tryParseIdentity(text: string): ProfileIdentity | null {
  let j: unknown;
  try { j = JSON.parse(text); } catch { return null; }
  if (j === null || typeof j !== "object" || !("loggedIn" in (j as Record<string, unknown>))) return null;
  const o = j as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === "string" ? v : null);
  return {
    loggedIn: o.loggedIn === true,
    email: s(o.email), orgName: s(o.orgName), subscriptionType: s(o.subscriptionType),
    orgId: s(o.orgId),
  };
}

/** Finds the index of the `}` that closes the `{` at position `start` — counts brace depth,
 *  but ignores those inside string literals (otherwise `{`/`}` in a value, e.g. in an
 *  email or organization name, would throw the count off). `-1` when the block never
 *  ends (truncated output). */
function findMatchingBrace(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/** `claude auth status` returns JSON, but in two different shapes, and there may be
 *  noise around it (warnings, npm update notice):
 *
 *  1. The COMMON case: `claude auth status` prints pretty-printed, i.e. MULTI-LINE
 *     JSON (verified live). No single line is valid JSON on its own —
 *     a "line by line" parser (fix round 1) failed on this and reported a logged-in
 *     account as logged out on EVERY call, which is worse than the original bug.
 *  2. Noise with its own braces around single-line JSON (`npm i -g ... {...}`)
 *     — a greedy regex from the first `{` to the last `}` in the whole output failed on this
 *     (it stretched the match across the real JSON).
 *
 *  Solution: first try to parse the WHOLE (trimmed) input at once — covers
 *  case 1 (clean output, no noise). When that fails, look for a BALANCED `{…}` block
 *  from every `{` in the text (respecting string literals, see `findMatchingBrace`)
 *  and take the first one that parses into an object with the `loggedIn` key — covers case 2
 *  and the combination of both (multi-line JSON with noise before/after). Do not use a lazy
 *  regex (`[\s\S]*?`) — it only works on flat JSON and this object need not stay flat. */
export function parseAuthStatus(raw: string): ProfileIdentity {
  const direct = tryParseIdentity(raw.trim());
  if (direct) return direct;

  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== "{") continue;
    const end = findMatchingBrace(raw, i);
    if (end === -1) continue;
    const candidate = tryParseIdentity(raw.slice(i, end + 1));
    if (candidate) return candidate;
  }
  return { ...NO_IDENTITY };
}

/** Profile identity — used to name the account automatically when it is added
 *  and to check profile health. Metadata is read from .claude.json, not from credentials;
 *  a profile with only the creds file reports email null (verified, see spec). */
export async function profileIdentity(d: ProfileDeps, id: string): Promise<ProfileIdentity> {
  assertId(id);
  const r = await d.run([
    "run", "--rm",
    "-v", `${CLAUDE_VOLUME}:/home/dev/.claude`,
    "-v", profileMount(id),
    "-e", `CLAUDE_CONFIG_DIR=${profilePath(id)}`,
    img(d), "claude", "auth", "status",
  ]);
  return parseAuthStatus(`${r.stdout}\n${r.stderr}`);
}

/** Result of removing a profile:
 *  - `removed` — the volume is gone, nothing is left of the account.
 *  - `purged`  — the volume holds a live mount, so it could not be deleted; its CONTENT
 *                has been wiped though, so no refresh token survived on disk. The empty
 *                shell `claude-acct-<id>` remains and can be deleted after recreating
 *                the session containers. */
export type ProfileRemoval = "removed" | "purged";

/** `docker volume rm -f` refuses to delete a volume held by a LIVE mount — and that is
 *  the normal state: EVERY session container mounts ALL profiles (accountMounts),
 *  so as long as a single session exists, deletion fails. Originally this threw an
 *  exception and the handler (api.ts DELETE /api/accounts/:id) turned it into a
 *  502 — but on a full devbox the account then could NEVER be removed, only by tearing down
 *  all sessions (review round 4, I4 only solved the worse half of the problem).
 *
 *  The invariant that I4 was really about is narrower than "the volume must disappear":
 *  no LIVE refresh token may remain on disk that no DB row points to anymore.
 *  It can be kept without deleting the volume — wiping its CONTENT is enough. So on
 *  "volume is in use" the profile is emptied and `purged` is returned; this tells the
 *  callee that after recreating sessions the empty shell still has to be deleted.
 *
 *  Emptying uses `find -mindepth 1 -delete`, not `rm -rf /profile/*`: a shell glob
 *  skips dotfiles (and `.credentials.json` is exactly that — precisely the one the whole
 *  measure is about) and an unmatched glob would also be passed literally.
 *  `-mindepth 1` protects the mountpoint itself, `-delete` removes recursively and removes
 *  symlinks as links, so the shared claude-home behind them stays untouched.
 *
 *  A failure to empty is still reported by an exception — there the invariant would really break. */
export async function removeProfile(d: ProfileDeps, id: string): Promise<ProfileRemoval> {
  assertId(id);
  const r = await d.run(["volume", "rm", "-f", profileVolume(id)]);
  if (r.code === 0) return "removed";
  if (!/volume is in use/i.test(r.stderr)) {
    throw new Error(`deleting profile ${id} failed: ${r.stderr.trim().slice(0, 300)}`);
  }
  const p = await d.run([
    "run", "--rm", ...AS_ROOT,
    "-v", `${profileVolume(id)}:/profile`,
    img(d), "find", "/profile", "-mindepth", "1", "-delete",
  ]);
  if (p.code !== 0) {
    throw new Error(`profile ${id} is held by running containers and could not be emptied: ${p.stderr.trim().slice(0, 300)}`);
  }
  return "purged";
}
