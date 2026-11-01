// Codex login and status (and Claude state) via ephemeral containers over shared
// auth volumes. devd runs on the host and can reach a volume (codex-home / claude-home) only
// through a container — same pattern as backup.ts. Docker calls are injected (run/sleep),
// so it can be tested without a real docker and without blocking the event loop.

export const CODEX_VOLUME = "codex-home";
export const CLAUDE_VOLUME = "claude-home";
export const LOGIN_CONTAINER = "devbox-codex-login";
// CLIProxyAPI (Codex/xAI subscriptions behind the proxy) and Grok Build have their own auth
// volumes — the same mount as `extraMounts` in index.ts (grok-home) or `infra/cliproxy.service`
// (cliproxy-auths), so the ephemeral login container writes to THE SAME place the real
// session/proxy containers read from.
export const CLIPROXY_VOLUME = "cliproxy-auths";
export const GROK_VOLUME = "grok-home";
const CLIPROXY_IMAGE = "eceasy/cli-proxy-api:latest";
const CLIPROXY_LOGIN_CONTAINER = (provider: ProxyProvider) => `devbox-cliproxy-${provider}-login`;
const GROK_LOGIN_CONTAINER = "devbox-grok-login";
const DEFAULT_IMAGE = "devbox:latest";

/** Reads one file from a docker volume via an ephemeral container — devd runs on the host
 *  and cannot see into the volume otherwise. Shared by codexPoller and grokPoller.
 *
 *  `dockerError !== null` = docker/the volume itself did not work (daemon not running, image
 *  missing, pull failed…) — that is NOT the same as "file missing" and the caller must not
 *  collapse it into "not signed in" (I3): the card would advise the operator to log in, they
 *  would succeed and still see "Not signed in", because the cause was elsewhere. A missing file
 *  inside a healthy container is detected by `cat` itself ("No such file") and that really is signed out.
 *
 *  The default mount is the parent directory of `path` — fits all existing callers
 *  (codex-home at /home/dev/.codex for .../auth.json, grok-home at /home/dev/.grok
 *  for .../auth.json). The Antigravity token however lives in a subdirectory
 *  (.../antigravity-cli/antigravity-oauth-token), whereas `antigravity-home` is
 *  mounted everywhere else (index.ts mounts, agentAuth login/status) as the whole
 *  /home/dev/.gemini — a mount on the token's parent directory would mean a different place
 *  than login/status, `cat` would always report "No such file" (signed-out) and docker would
 *  on the first poll create a stray volume itself with a mountpoint inside the image (root:root).
 *  Hence the optional `mountPath` for callers where the mount differs from the parent of `path`. */
export async function readVolumeFile(
  d: { run: (cmd: string[]) => Promise<{ code: number; stdout: string; stderr: string }>; image?: string },
  volume: string, path: string, mountPath?: string,
): Promise<{ raw: string | null; dockerError: string | null }> {
  const r = await d.run(["run", "--rm", "-v", `${volume}:${mountPath ?? path.slice(0, path.lastIndexOf("/"))}`,
    d.image ?? DEFAULT_IMAGE, "cat", path]);
  if (r.code === 0) return { raw: r.stdout.trim() === "" ? null : r.stdout, dockerError: null };
  if (r.stderr.includes("No such file")) return { raw: null, dockerError: null };
  // A truncated snippet of stderr — traceable, but the card does not overflow with raw docker output.
  return { raw: null, dockerError: (r.stderr.trim() || `docker run failed (exit ${r.code})`).slice(0, 300) };
}

/** Batch read from a volume: one ephemeral container, one `sh -c` script. For
 *  harvesters that need more than a cat of one file (offsets, find, grep of
 *  the latest events) — N × readVolumeFile would mean N × docker run.
 *
 *  WITHOUT `--entrypoint sh` — deliberately the same as `readVolumeFile` above: the image
 *  `devbox:latest` has ENTRYPOINT `devbox-entrypoint` (image/entrypoint.sh), and with
 *  non-empty arguments it does `exec "$@"` directly (lines 5-7), so `docker run
 *  ... devbox:latest sh -c script` runs `sh -c script` directly, no entrypoint
 *  override needed. `proxyCredsPresent` above already uses the same pattern. */
export async function runInVolume(
  d: { run: (cmd: string[]) => Promise<{ code: number; stdout: string; stderr: string }>; image?: string },
  volume: string, mountPath: string, script: string,
): Promise<{ out: string | null; dockerError: string | null }> {
  const r = await d.run(["run", "--rm", "-v", `${volume}:${mountPath}`, d.image ?? DEFAULT_IMAGE, "sh", "-c", script]);
  if (r.code === 0) return { out: r.stdout, dockerError: null };
  return { out: null, dockerError: (r.stderr.trim() || `docker run failed (exit ${r.code})`).slice(0, 300) };
}

export interface AuthProvider { loggedIn: boolean; detail: string }
export interface CodexAuthDeps {
  run: (cmd: string[], input?: string) => Promise<{ code: number; stdout: string; stderr: string }>;
  sleep: (ms: number) => Promise<void>;
  image?: string;
}

// A generic https URL without a hard-wired domain — unlike DEVICE_URL_RE below (Codex),
// this form is used wherever the domain is not certain in advance (proxy login, Grok).
const URL_RE = /https:\/\/[^\s"'<>]+/;

const DEVICE_URL_RE = /https:\/\/auth\.openai\.com\/codex\/device/;
// FIX relative to the brief's reference (see task-3-report.md "Concerns"): {4}-{4} with \b never
// matched a colored log — the ANSI escape sequence (\x1b[94m) ends with the letter "m", so
// there is no word boundary between it and the first character of the code, and moreover the
// live-verified code sample in the brief itself is 4-5 characters (OC4S-5ENNP), not 4-4. So the
// log is first stripped of ANSI sequences and the quantifier is {4,5} on both sides of the dash.
// Generic CSI stripper: \x1b[ + parameters/question mark + final letter (m=color, A/K=cursor/erase,
// ?25l/h=spinner). codex login --device-auth emits more than just colors while waiting.
const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]/g;
const DEVICE_CODE_RE = /\b([A-Z0-9]{4,5}-[A-Z0-9]{4,5})\b/;

/** URL+code from the (colored) device-auth log; null until both are present. */
export function parseDeviceAuth(log: string): { url: string; code: string } | null {
  const clean = log.replace(ANSI_RE, "");
  const url = clean.match(DEVICE_URL_RE)?.[0];
  const code = clean.match(DEVICE_CODE_RE)?.[1];
  if (!url || !code) return null;
  return { url, code };
}

/** URL from the (colored) proxy login log (CLIProxyAPI `--no-browser`) — the same ANSI
 *  stripper as for device-auth, because without removal the color escape sequence
 *  sticks directly to the URL (no word boundary between "m" and "h"). The domain is not hard-wired
 *  (unlike parseDeviceAuth) — the proxy prints the login URL for whichever
 *  provider (`--codex-login`/`--xai-login`) it is logging into. */
export function parseOauthUrl(log: string): string | null {
  return log.replace(ANSI_RE, "").match(URL_RE)?.[0] ?? null;
}

/** URL+code from the Grok CLI device-auth log (`grok login --device-auth`). Its own parser,
 *  not parseDeviceAuth directly: Grok's URL domain is not auth.openai.com.
 *
 *  The output is MEASURED, not guessed — three runs on grok 1.0.5, see
 *  the Grok research notes (2026-08-20), section "Measured further 2026-08-20":
 *  the URL has the form https://accounts.x.ai/oauth2/device?user_code=<CODE>, the code is 4-4
 *  (e.g. 4HR3-QMWH), the whole output goes to stderr (stdout stays empty) and is done
 *  within 1-2 s. The non-hard-wired domain was thereby confirmed as the right choice.
 *
 *  Two things the measurement refined relative to the original assumption: the shared
 *  DEVICE_CODE_RE with the {4,5} quantifier matches, but is broader than Grok needs;
 *  and the code is in fact taken FROM THE URL — `.match()` without /g returns the first occurrence, and
 *  that is in `user_code=`, not on the later "Confirm this code" line. The value is identical
 *  in both places, so the result is correct. */
export function parseGrokDeviceAuth(log: string): { url: string; code: string } | null {
  const clean = log.replace(ANSI_RE, "");
  const url = clean.match(URL_RE)?.[0];
  const code = clean.match(DEVICE_CODE_RE)?.[1];
  if (!url || !code) return null;
  return { url, code };
}

// codex login status writes the state to STDOUT and STDERR depending on version/state and on "not logged in"
// exits non-zero — so we call it with COMBINED output and do not decide by the exit code.
// Order matters: "not logged in" contains the substring "logged in", so test it first.
export function parseLoginStatus(out: string): boolean {
  if (/not logged in/i.test(out)) return false;
  return /logged in/i.test(out);
}

function img(d: CodexAuthDeps) { return d.image ?? DEFAULT_IMAGE; }

// CLIProxyAPI has (at least as measured) no "login status" command of its own like codex — so
// the status is based on the presence of a credential file in the volume, exactly as the brief asks.
// Actually observed shape (CLIProxyAPI documentation/OSS sources): `<provider>-<email>.json`
// in auth-dir. The mount is NOT at `/root/...` (like the production `-v cliproxy-auths:/root/.cli-proxy-api`
// in cliproxy.service) — this container runs on `devbox:latest` as user `dev`, and
// `/root` on THIS image is unreadable to anyone other than root regardless of the volume's
// content. `/creds` is therefore a neutral point where the volume is just mounted for reading.
async function proxyCredsPresent(d: CodexAuthDeps, provider: ProxyProvider): Promise<boolean> {
  const r = await d.run(["run", "--rm", "-v", `${CLIPROXY_VOLUME}:/creds`, img(d), "sh", "-c", `ls /creds/${provider}-*.json`]);
  return r.code === 0;
}

export async function authStatus(d: CodexAuthDeps): Promise<{
  claude: AuthProvider; codex: AuthProvider; proxyCodex: AuthProvider; proxyXai: AuthProvider;
  proxyAntigravity: AuthProvider; grok: AuthProvider; antigravity: AuthProvider;
}> {
  // Seven independent `docker run`s AT ONCE, not one after another: sequentially /api/auth
  // (Settings) took 3.0–3.8 s live, each container ~0.7 s and none of them depends on another.
  const [c, x, pc, px, pa, g, a] = await Promise.all([
    // Claude: .credentials.json exists on claude-home (exit 0 = it does).
    d.run(["run", "--rm", "-v", `${CLAUDE_VOLUME}:/h`, img(d), "test", "-s", "/h/.credentials.json"]),
    d.run(["run", "--rm", "-v", `${CODEX_VOLUME}:/home/dev/.codex`, img(d), "codex", "login", "status"]),
    proxyCredsPresent(d, "codex"),
    proxyCredsPresent(d, "xai"),
    proxyCredsPresent(d, "antigravity"),
    d.run(["run", "--rm", "-v", `${GROK_VOLUME}:/home/dev/.grok`, img(d), "sh", "-c",
      "test -s /home/dev/.grok/auth.json || test -s /home/dev/.grok/.xai_api_key"]),
    // Antigravity (native agy, not proxy): existence of the token on antigravity-home
    // (same pattern as Claude/Grok).
    d.run(["run", "--rm", "-v", `${AGY_VOLUME}:/home/dev/.gemini`, img(d), "test", "-s", AGY_TOKEN]),
  ]);
  const claude: AuthProvider = c.code === 0
    ? { loggedIn: true, detail: "signed in via devbox Max" }
    : { loggedIn: false, detail: "not signed in" };
  // Codex: codex login status in a container over codex-home. "Not logged in" goes to
  // stderr with a non-zero exit code — hence combined output and no gating on code.
  const combined = `${x.stdout}\n${x.stderr}`;
  const codexLogged = parseLoginStatus(combined);
  const codex: AuthProvider = codexLogged
    ? { loggedIn: true, detail: combined.trim().slice(0, 120) }
    : { loggedIn: false, detail: /not logged in/i.test(combined) ? "not signed in" : "codex unavailable (rebuild the image?)" };
  // Proxy accounts (CLIProxyAPI): codex and xai are two INDEPENDENT login states.
  const proxyCodex: AuthProvider = pc
    ? { loggedIn: true, detail: "signed in via proxy" } : { loggedIn: false, detail: "not signed in" };
  const proxyXai: AuthProvider = px
    ? { loggedIn: true, detail: "signed in via proxy" } : { loggedIn: false, detail: "not signed in" };
  const proxyAntigravity: AuthProvider = pa
    ? { loggedIn: true, detail: "signed in via proxy" } : { loggedIn: false, detail: "not signed in" };
  // Grok Build: auth.json from `grok login --device-auth`, or (fallback) a stored XAI_API_KEY.
  const grok: AuthProvider = g.code === 0
    ? { loggedIn: true, detail: "signed in" } : { loggedIn: false, detail: "not signed in" };
  const antigravity: AuthProvider = a.code === 0
    ? { loggedIn: true, detail: "signed in" } : { loggedIn: false, detail: "not signed in" };
  return { claude, codex, proxyCodex, proxyXai, proxyAntigravity, grok, antigravity };
}

export async function codexLoginStart(d: CodexAuthDeps): Promise<{ url: string; code: string; expiresInSec: number }> {
  await d.run(["rm", "-f", LOGIN_CONTAINER]);                       // remove the old login container
  const run = await d.run(["run", "-d", "--name", LOGIN_CONTAINER, "-v", `${CODEX_VOLUME}:/home/dev/.codex`, img(d), "codex", "login", "--device-auth"]);
  if (run.code !== 0) throw new Error(`codex login start failed: ${run.stderr.trim().slice(0, 300)}`);
  // Log poll: codex takes a while to print URL+code. Up to ~15 attempts at 500 ms.
  for (let i = 0; i < 15; i++) {
    await d.sleep(500);
    const logs = await d.run(["logs", LOGIN_CONTAINER]);
    const parsed = parseDeviceAuth(logs.stdout + logs.stderr);
    if (parsed) return { ...parsed, expiresInSec: 900 };
  }
  await d.run(["rm", "-f", LOGIN_CONTAINER]);
  throw new Error("could not read the device-auth code from the log");
}

export async function codexLoginStatus(d: CodexAuthDeps): Promise<"pending" | "done" | "error"> {
  const inspect = await d.run(["inspect", "-f", "{{.State.Status}}", LOGIN_CONTAINER]);
  const status = await d.run(["run", "--rm", "-v", `${CODEX_VOLUME}:/home/dev/.codex`, img(d), "codex", "login", "status"]);
  const loggedIn = parseLoginStatus(`${status.stdout}\n${status.stderr}`);
  if (loggedIn) { await d.run(["rm", "-f", LOGIN_CONTAINER]); return "done"; }
  // the login container is still running → waiting for completion in the browser
  if (inspect.code === 0 && inspect.stdout.trim() === "running") return "pending";
  // the container finished/disappeared and still not logged in → error (timeout/cancelled)
  await d.run(["rm", "-f", LOGIN_CONTAINER]);
  return "error";
}

export async function codexLogout(d: CodexAuthDeps): Promise<void> {
  await d.run(["rm", "-f", LOGIN_CONTAINER]);
  await d.run(["run", "--rm", "-v", `${CODEX_VOLUME}:/home/dev/.codex`, img(d), "codex", "logout"]);
}

/* ============================== proxy accounts (CLIProxyAPI) ============================== */

// Config of the main proxy — the login binary crashes immediately without it ("failed to load
// config"), so the login container mounts it from the same place as cliproxy.service.
const CLIPROXY_CONFIG = "/etc/devd/cliproxy/config.yaml";
// OAuth callback login flow: in login mode CLIProxyAPI opens an http server on 1455
// and the authorization URL's redirect_uri points to http://localhost:1455/… It is published only on
// the host's loopback — it is carried to the browser on the mac via an SSH tunnel / listener bridge,
// the port must not reach the internet (docker bypasses ufw, see infra/docker-user-firewall.service).
export const CLIPROXY_CALLBACK_PORT = 1455;

export type ProxyProvider = "codex" | "xai" | "antigravity";
const PROXY_PROVIDERS: readonly ProxyProvider[] = ["codex", "xai", "antigravity"];
export function isProxyProvider(v: unknown): v is ProxyProvider {
  return typeof v === "string" && (PROXY_PROVIDERS as readonly string[]).includes(v);
}
/** Extra argv for login. Antigravity has its own default callback port in CLIProxyAPI;
 *  switching it to 1455 sends the callback the same way (listener bridge + relay) as for
 *  Codex/xAI — measured 2026-10-15 (redirect_uri=http://localhost:1455/oauth-callback). */
const PROXY_LOGIN_EXTRA: Record<ProxyProvider, string[]> = {
  codex: [], xai: [], antigravity: ["--oauth-callback-port", String(CLIPROXY_CALLBACK_PORT)],
};

/** Login to an account behind CLIProxyAPI (Codex or xAI/Grok subscription). The login container
 *  runs directly from the proxy image (not from devbox:latest) over the SHARED volume `cliproxy-auths` —
 *  the same volume `infra/cliproxy.service` mounts, so credentials written here are
 *  seen by the proxy immediately. `--no-browser`: the server has nothing to open, the proxy prints the URL
 *  to the log instead (verified against the actual CLIProxyAPI documentation: `--codex-login`/`--xai-login`
 *  are real flags, `--no-browser` is real too, not a guess from the brief).
 *
 *  `./CLIProxyAPI` is given EXPLICITLY: the image since v7.2.137 has no ENTRYPOINT (only
 *  Cmd=["./CLIProxyAPI"]), so arguments after the image name REPLACE Cmd — a bare
 *  `--codex-login` is then run by docker as a binary and the container dies with exit 127
 *  while still in the Created state (measured live 2026-08-23, the dashboard showed
 *  HTTP 502 for it without a single log line). */
export async function proxyLoginStart(d: CodexAuthDeps, provider: ProxyProvider): Promise<{ url: string }> {
  const name = CLIPROXY_LOGIN_CONTAINER(provider);
  await d.run(["rm", "-f", name]);
  const run = await d.run(["run", "-d", "--name", name,
    "-v", `${CLIPROXY_VOLUME}:/root/.cli-proxy-api`,
    "-v", `${CLIPROXY_CONFIG}:/CLIProxyAPI/config.yaml`,
    "-p", `127.0.0.1:${CLIPROXY_CALLBACK_PORT}:${CLIPROXY_CALLBACK_PORT}`,
    CLIPROXY_IMAGE, "./CLIProxyAPI", `--${provider}-login`, "--no-browser", ...PROXY_LOGIN_EXTRA[provider]]);
  if (run.code !== 0) throw new Error(`login start failed: ${run.stderr.trim().slice(0, 300)}`);
  for (let i = 0; i < 15; i++) {
    await d.sleep(500);
    const logs = await d.run(["logs", name]);
    const url = parseOauthUrl(logs.stdout + logs.stderr);
    if (url) return { url };
  }
  await d.run(["rm", "-f", name]);
  throw new Error("could not read the login URL from the log");
}

export async function proxyLoginStatus(d: CodexAuthDeps, provider: ProxyProvider): Promise<"pending" | "done" | "error"> {
  const name = CLIPROXY_LOGIN_CONTAINER(provider);
  const inspect = await d.run(["inspect", "-f", "{{.State.Status}}", name]);
  const loggedIn = await proxyCredsPresent(d, provider);
  if (loggedIn) { await d.run(["rm", "-f", name]); return "done"; }
  if (inspect.code === 0 && inspect.stdout.trim() === "running") return "pending";
  await d.run(["rm", "-f", name]);
  return "error";
}

/* ============================== Grok Build ============================== */

/** Headless login of the Grok Build CLI — `grok login --device-auth` (alias `--device-code`),
 *  documented directly in `grok --help` for headless/remote environments (verified live in
 *  Task 7, not a guess). The container runs from `devbox:latest` (that is where the `grok` binary is), not from
 *  the proxy image — this is a native Grok Build account, not an account behind the proxy.
 *
 *  Review round 1, Minor: does NOT RETURN `expiresInSec` (unlike `codexLoginStart`).
 *  Measured in the Grok research notes (2026-08-20, Task 14 addendum):
 *  the code and URL arrive within ~1-2 s, the code has the form XXXX-XXXX — but the actual VALIDITY
 *  PERIOD of the code was NOT measured (it would need real x.ai credentials and waiting until expiry).
 *  Codex's `900` was transferable earlier, because its own log literally says
 *  "(expires in 15 minutes)" — Grok has no such line anywhere, so it would be a made-up
 *  number, not an adopted fact. Better no number than a wrong one. */
export async function grokLoginStart(d: CodexAuthDeps): Promise<{ url: string; code: string }> {
  await d.run(["rm", "-f", GROK_LOGIN_CONTAINER]);
  const run = await d.run(["run", "-d", "--name", GROK_LOGIN_CONTAINER, "-v", `${GROK_VOLUME}:/home/dev/.grok`, img(d), "grok", "login", "--device-auth"]);
  if (run.code !== 0) throw new Error(`grok login start failed: ${run.stderr.trim().slice(0, 300)}`);
  for (let i = 0; i < 15; i++) {
    await d.sleep(500);
    const logs = await d.run(["logs", GROK_LOGIN_CONTAINER]);
    const parsed = parseGrokDeviceAuth(logs.stdout + logs.stderr);
    if (parsed) return parsed;
  }
  await d.run(["rm", "-f", GROK_LOGIN_CONTAINER]);
  throw new Error("could not read the grok device-auth code from the log");
}

export async function grokLoginStatus(d: CodexAuthDeps): Promise<"pending" | "done" | "error"> {
  const inspect = await d.run(["inspect", "-f", "{{.State.Status}}", GROK_LOGIN_CONTAINER]);
  const status = await d.run(["run", "--rm", "-v", `${GROK_VOLUME}:/home/dev/.grok`, img(d), "test", "-s", "/home/dev/.grok/auth.json"]);
  if (status.code === 0) { await d.run(["rm", "-f", GROK_LOGIN_CONTAINER]); return "done"; }
  if (inspect.code === 0 && inspect.stdout.trim() === "running") return "pending";
  await d.run(["rm", "-f", GROK_LOGIN_CONTAINER]);
  return "error";
}

/* ============================== Antigravity ============================== */

/** Antigravity CLI (agy) — Google OAuth without a browser. Unlike device-auth
 *  (Codex/Grok), agy waits for an authorization code to be PASTED into a field in the TUI, so the login
 *  container must be controllable: agy runs in a tmux pane and devd sends keys via
 *  `docker exec … tmux send-keys`. The pane is 1000 columns wide so the 704-character URL
 *  fits on one line (measured 2026-10-15, the Antigravity research notes). */
export const AGY_VOLUME = "antigravity-home";
const AGY_LOGIN_CONTAINER = "devbox-agy-login";
const AGY_HOME = "/home/dev/.gemini/antigravity-cli";
const AGY_TOKEN = `${AGY_HOME}/antigravity-oauth-token`;
const AGY_ONBOARDED = `${AGY_HOME}/.devbox-onboarded`;
const AGY_URL_RE = /https:\/\/accounts\.google\.com\/o\/oauth2\/auth\?[^\s]+/;

export function parseAgyLoginUrl(pane: string): string | null {
  return pane.match(AGY_URL_RE)?.[0] ?? null;
}

/** The code goes into the terminal as keystrokes — a space, CR or escape would be TUI commands. */
export function isValidAgyCode(code: unknown): code is string {
  return typeof code === "string" && code.length > 0 && code.length <= 512 && /^[\x21-\x7e]+$/.test(code);
}

const agyCapture = (d: CodexAuthDeps) => d.run(["exec", AGY_LOGIN_CONTAINER, "tmux", "capture-pane", "-pJ", "-S", "-"]);

export async function agyLoginStart(d: CodexAuthDeps): Promise<{ url: string }> {
  await d.run(["rm", "-f", AGY_LOGIN_CONTAINER]);
  const run = await d.run(["run", "-d", "--name", AGY_LOGIN_CONTAINER, "-v", `${AGY_VOLUME}:/home/dev/.gemini`,
    "-e", "TERM=xterm-256color", img(d), "sh", "-c", "tmux new-session -d -x 1000 -y 50 agy; exec sleep 900"]);
  if (run.code !== 0) throw new Error(`antigravity login start failed: ${run.stderr.trim().slice(0, 300)}`);
  let chose = false;
  for (let i = 0; i < 30; i++) {
    await d.sleep(500);
    const pane = (await agyCapture(d)).stdout;
    const url = parseAgyLoginUrl(pane);
    if (url) return { url };
    if (!chose && /Select login method/.test(pane)) {
      await d.run(["exec", AGY_LOGIN_CONTAINER, "tmux", "send-keys", "Enter"]);   // 1. Google OAuth
      chose = true;
    }
  }
  await d.run(["rm", "-f", AGY_LOGIN_CONTAINER]);
  throw new Error("could not read the Antigravity login URL from the pane");
}

export async function agyLoginCode(d: CodexAuthDeps, code: string): Promise<void> {
  if (!isValidAgyCode(code)) throw new Error("invalid authorization code");
  const r = await d.run(["exec", "-i", AGY_LOGIN_CONTAINER, "sh", "-c", 'tmux send-keys -l -- "$(cat)"; tmux send-keys Enter'], code);
  if (r.code !== 0) throw new Error("login container is not running — start the login again");
}

export async function agyLoginStatus(d: CodexAuthDeps): Promise<"pending" | "done" | "error"> {
  const token = await d.run(["run", "--rm", "-v", `${AGY_VOLUME}:/home/dev/.gemini`, img(d), "test", "-s", AGY_TOKEN]);
  if (token.code === 0) { await d.run(["rm", "-f", AGY_LOGIN_CONTAINER]); return "done"; }
  const inspect = await d.run(["inspect", "-f", "{{.State.Status}}", AGY_LOGIN_CONTAINER]);
  if (inspect.code !== 0 || inspect.stdout.trim() !== "running") { await d.run(["rm", "-f", AGY_LOGIN_CONTAINER]); return "error"; }
  // agy can crash in such a way that the tmux session disappears, but `sleep 900` in the entrypoint
  // keeps the container alive — inspect then keeps reporting "running". capture-pane on a vanished
  // session ends with a non-zero exit (empty stdout), so without this check
  // `/Got an error:/` would never match and the status would stay "pending" for the full 15 minutes.
  const capture = await agyCapture(d);
  if (capture.code !== 0 || /Got an error:/.test(capture.stdout)) { await d.run(["rm", "-f", AGY_LOGIN_CONTAINER]); return "error"; }
  return "pending";
}

/** Logout = delete the token and the onboarding marker (a new account may want onboarding again).
 *  A running session holds the token in memory — the UI handles that with a message, not here. */
export async function agyLogout(d: CodexAuthDeps): Promise<void> {
  const r = await d.run(["run", "--rm", "-v", `${AGY_VOLUME}:/home/dev/.gemini`, img(d), "rm", "-f", AGY_TOKEN, AGY_ONBOARDED]);
  if (r.code !== 0) throw new Error(`antigravity logout failed: ${r.stderr.trim().slice(0, 300)}`);
}

