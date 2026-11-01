import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseDialogAnswer, sshDialogScript, type SshApprovalReq } from "./sshPrompt";
import { dbDialogScript, parseDbAnswer, type DbRequestReq } from "./dbPrompt";

export interface Mapping { from: string; to: string }
export type Spawner = (...cmd: string[]) => { code: number };
export type TextSpawner = (...cmd: string[]) => { code: number; stdout: string };
/** Text output without blocking the event loop — for commands that can run for tens
 *  of seconds (approval dialog). Its own type, not a `TextSpawner` returning a Promise:
 *  synchronous callers (clipboard and co.) should not wait on it. */
export type AsyncTextSpawner = (...cmd: string[]) => Promise<{ code: number; stdout: string }>;

const defaultRun: Spawner = (...cmd) => {
  const p = Bun.spawnSync(cmd, { stdout: "ignore", stderr: "ignore" });
  return { code: p.exitCode ?? 1 };
};

const defaultTextRun: TextSpawner = (...cmd) => {
  const p = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "ignore" });
  return { code: p.exitCode ?? 1, stdout: p.stdout.toString() };
};

const defaultTextRunAsync: AsyncTextSpawner = async (...cmd) => {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore" });
  // Stdout is read CONCURRENTLY with waiting for the process to exit. If we waited for
  // `exited` first and read only afterwards, a full pipe would block the process and both sides
  // would wait on each other — with `osascript`'s short output it would not break, but it is a trap
  // we do not want to leave set here.
  const [stdout, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  return { code: code ?? 1, stdout };
};

// Signed helper whose bundle icon is the devbox amber >_ mark. Built + installed by
// listener/notifier/build.sh; posting through it (UNUserNotificationCenter) is the
// only way to get a custom icon on macOS 26 — osascript works but always shows the
// generic Script Editor icon, and terminal-notifier never displays there at all.
export function defaultNotifierBin(): string {
  return join(homedir(), "Applications", "Devbox Notifier.app", "Contents", "MacOS", "devbox-notify");
}

export function mapPath(mappings: Mapping[], path: string): string | null {
  const segments = path.split("/");
  if (segments.includes("..") || segments.includes(".")) return null;
  const hit = [...mappings]
    .sort((a, b) => b.from.length - a.from.length)
    .find((m) => path === m.from || path.startsWith(m.from + "/"));
  return hit ? hit.to + path.slice(hit.from.length) : null;
}

export interface NotifySession { id: string; project: string; repo: string }
export interface NotifyOpts { sound?: boolean; session?: NotifySession }

// AppleScript: walk Warp's windows and focus the first one whose title contains needle
// (Warp tabs are renamed according to the Claude terminal title). AX sees only the title
// of the ACTIVE tab of each window — a background tab is not found (accepted limitation,
// it falls back to openWarpAttach). Not found = `error number 1` → osascript exit 1.
export function focusWarpScript(needle: string): string {
  const esc = needle.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  return [
    'tell application "System Events" to tell process "Warp"',
    "  repeat with w in windows",
    `    if name of w contains "${esc}" then`,
    '      perform action "AXRaise" of w',
    "      set frontmost to true",
    "      return",
    "    end if",
    "  end repeat",
    "end tell",
    "error number 1",
  ].join("\n");
}

// Warp launch config (the only reliable way to "open a new tab with a command"):
// rewritten every time into the same file, warp://launch runs it.
export function attachLaunchConfig(sessionId: string): string {
  return [
    "name: devbox-attach",
    "windows:",
    "  - tabs:",
    `      - title: devbox ${sessionId}`,
    "        layout:",
    '          cwd: "~"',
    "          commands:",
    `            - exec: dev attach ${sessionId}`,
    "",
  ].join("\n");
}

/** AppleScript: writes the clipboard as a PNG to a file; fails without an image (exit 1).
 * try/on error closes the file handle, otherwise an open accessor would be left dangling. */
export function clipboardPngScript(path: string): string {
  return [
    `set f to open for access POSIX file "${path}" with write permission`,
    "try",
    "  set eof f to 0",
    "  write (the clipboard as «class PNGf») to f",
    "  close access f",
    "on error",
    "  close access f",
    "  error number 1",
    "end try",
  ].join("\n");
}

// The compiled Swift helper (listener/clipread.swift) reads the clipboard natively via
// NSPasteboard — ~160× faster than the osascript «class PNGf» coercion (fullscreen
// screenshot 1.6 s → 0.01 s). install.ts builds it; when it is missing, the clipboard*
// methods below fall back to osascript/pbpaste.
export function defaultClipreadBin(): string {
  return join(homedir(), "Applications", "devbox-clipread");
}

export const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MB; above → 413 (use SMB)

export interface ClipDeps {
  out?: (...cmd: string[]) => { code: number; stdout: string };
  readFile?: (p: string) => Uint8Array;
  rm?: (p: string) => void;
  tmpFile?: () => string;
  bin?: string | null; // undefined = autodetect; null = force osascript; path = force helper (tests)
}

const defaultOut: NonNullable<ClipDeps["out"]> = (...cmd) => {
  const p = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "ignore" });
  return { code: p.exitCode ?? 1, stdout: p.stdout.toString() };
};

export interface ClickDeps {
  launchDir?: string;
  dashboardUrl?: string;
  writeFile?: (path: string, content: string) => void;
}

export interface Actions {
  open(path: string): { code: number };
  openUrl(url: string): { code: number };
  /** Temporary bridge for the proxy login OAuth callback: open 127.0.0.1:1455 and
   *  forward to the devd relay (`relayBase`). `ok: false` = the port could not be
   *  bound (typically a local `codex login` on the mac holds 1455). */
  startProxyBridge(relayBase: string, ttlMs: number): { ok: boolean };
  notify(title: string, message: string, opts?: NotifyOpts): { code: number };
  focusWarp(needle: string): boolean;
  openWarpAttach(sessionId: string): { code: number };
  openDashboard(): { code: number };
  clipboardTargets(): string[];
  clipboardImage(): Uint8Array | null;
  clipboardText(): string | null;
  clipboardFile(): { name: string; bytes: Uint8Array } | { tooBig: true } | null;
  /** Asynchronous on purpose: the dialog stays up for up to 85 s and the listener is single-threaded — with
   *  `spawnSync` it would serve NOTHING else for that time (neither notifications nor /clicked).
   *  A review finding. */
  askSshApproval(req: SshApprovalReq): Promise<{ decision: "approve" | "deny"; grantMinutes: number } | null>;
  askDbRequest(req: DbRequestReq): Promise<{ decision: "deny" | "open" } | null>;
}

/* ============================== proxy-bridge ============================== */

// The proxy login OAuth callback targets http://localhost:1455 — CLIProxyAPI has
// the redirect_uri hardwired, so the port cannot be changed. The login container on the VPS
// publishes the port only on the host loopback and devd exposes it via a relay endpoint;
// this bridge does the last hop: browser on the mac → 127.0.0.1:1455 → relay.
const PROXY_BRIDGE_PORT = 1455;

// Singleton: a new login closes the previous bridge (a different relayBase on the same port
// would otherwise lose the bind and the login would hang on "Waiting…" without explanation).
let bridge: { stop(): void; timer: ReturnType<typeof setTimeout> } | null = null;

function realStartProxyBridge(relayBase: string, ttlMs: number): { ok: boolean } {
  if (bridge) { clearTimeout(bridge.timer); bridge.stop(); bridge = null; }
  try {
    const srv = Bun.serve({
      hostname: "127.0.0.1", port: PROXY_BRIDGE_PORT,
      fetch: async (req) => {
        const u = new URL(req.url);
        try {
          const r = await fetch(
            `${relayBase}/api/auth/proxy/relay?path=${encodeURIComponent(u.pathname + u.search)}`,
            { signal: AbortSignal.timeout(15_000) },
          );
          // Status and content-type are passed through verbatim — CLIProxyAPI's success page "you can
          // close this window" should arrive exactly as it was sent.
          return new Response(await r.arrayBuffer(), {
            status: r.status,
            headers: { "content-type": r.headers.get("content-type") ?? "text/plain; charset=utf-8" },
          });
        } catch (e) {
          return new Response(`bridge relay failed: ${(e as Error).message}`, { status: 502 });
        }
      },
    });
    // TTL: the bridge must not hold the port forever — a local `codex login` on the mac
    // uses the same 1455. unref, so the timer does not keep the process alive.
    const timer = setTimeout(() => { srv.stop(true); bridge = null; }, ttlMs);
    timer.unref?.();
    bridge = { stop: () => srv.stop(true), timer };
    return { ok: true };
  } catch (e) {
    console.error("proxy bridge start failed:", (e as Error).message);
    return { ok: false };
  }
}

export function realActions(
  run: Spawner = defaultRun,
  notifierBin: string | null = defaultNotifierBin(),
  click: ClickDeps = {},
  clip: ClipDeps = {},
  textRun: TextSpawner = defaultTextRun,
  textRunAsync: AsyncTextSpawner = defaultTextRunAsync,
): Actions {
  const notifier = notifierBin && existsSync(notifierBin) ? notifierBin : null;
  const launchDir = click.launchDir ?? join(homedir(), ".warp", "launch_configurations");
  const writeFileClick = click.writeFile ?? ((p: string, content: string) => {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  });
  const out = clip.out ?? defaultOut;
  const readFile = clip.readFile ?? ((p: string) => new Uint8Array(readFileSync(p)));
  const rm = clip.rm ?? ((p: string) => rmSync(p, { force: true }));
  const tmpFile = clip.tmpFile ?? (() => join(tmpdir(), `devbox-clip-${process.pid}-${Date.now()}.png`));
  // Resolved once at listener startup; after building the helper a restart is required.
  const clipBin = clip.bin !== undefined ? clip.bin : (existsSync(defaultClipreadBin()) ? defaultClipreadBin() : null);
  return {
    // Only reveal in Finder (`open -R`), NEVER open: the path leads into the session workspace,
    // which the agent writes to (and for a shared session also the terminal guest). `open x.command` / `.app` /
    // `.terminal` from the SMB volume would run code on the owner's mac without quarantine.
    // The path is always mapped under mapping (absolute, does not start with a dash — see mapPath).
    open: (path) => run("open", "-R", path),
    openUrl: (url) => run("open", url),
    startProxyBridge: realStartProxyBridge,
    notify: (title, message, opts) => {
      // Prefer the Devbox notifier app (custom icon, userInfo for the click); fall back
      // to osascript (generic icon, no click payload) when missing or failing.
      if (notifier) {
        const args = [notifier, title, message];
        if (opts?.sound) args.push("--sound");
        if (opts?.session) args.push("--user-info", JSON.stringify(opts.session));
        const r = run(...args);
        if (r.code === 0) return r;
      }
      return run("osascript", "-e", `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`);
    },
    focusWarp: (needle) => run("osascript", "-e", focusWarpScript(needle)).code === 0,
    openWarpAttach: (sessionId) => {
      writeFileClick(join(launchDir, "devbox-attach.yaml"), attachLaunchConfig(sessionId));
      return run("open", "warp://launch/devbox-attach.yaml"); // nastartuje i Warp
    },
    openDashboard: () => (click.dashboardUrl ? run("open", click.dashboardUrl) : { code: 0 }),
    clipboardTargets: () => {
      if (clipBin) {
        const r = out(clipBin, "targets");
        return r.code === 0 ? r.stdout.split("\n").filter(Boolean) : [];
      }
      const r = out("osascript", "-e", "clipboard info");
      if (r.code !== 0) return [];
      const t: string[] = [];
      if (/«class PNGf»|TIFF/i.test(r.stdout)) t.push("image/png");
      if (/string|utf8/i.test(r.stdout)) t.push("text/plain");
      return t;
    },
    clipboardImage: () => {
      const p = tmpFile();
      const r = clipBin ? out(clipBin, "image", p) : out("osascript", "-e", clipboardPngScript(p));
      if (r.code !== 0) { rm(p); return null; }
      try {
        const bytes = readFile(p);
        return bytes.length > 0 ? bytes : null;
      } finally { rm(p); }
    },
    clipboardText: () => {
      const r = clipBin ? out(clipBin, "text") : out("pbpaste");
      return r.code === 0 && r.stdout.length > 0 ? r.stdout : null;
    },
    clipboardFile: () => {
      if (!clipBin) return null; // without the compiled helper the file is not supported
      const p = tmpFile();
      const r = out(clipBin, "file", p, String(MAX_FILE_BYTES));
      if (r.code === 4) { rm(p); return { tooBig: true }; }
      if (r.code !== 0) { rm(p); return null; }
      const name = r.stdout.trim();
      try {
        const bytes = readFile(p);
        return bytes.length > 0 && name ? { name, bytes } : null;
      } finally { rm(p); }
    },
    /** The modal is blocking for the HUMAN (it should grab attention, 85s cap), but not for the
     *  listener: `osascript` runs asynchronously, so other requests keep going while waiting
     *  for the click. The answer is returned to the caller (devd), the listener itself decides
     *  nothing. */
    async askSshApproval(req) {
      const r = await textRunAsync("osascript", "-e", sshDialogScript(req));
      return parseDialogAnswer(r.stdout);
    },
    async askDbRequest(req) {
      const r = await textRunAsync("osascript", "-e", dbDialogScript(req));
      const ans = parseDbAnswer(r.stdout);
      // "Open" decides nothing — it just opens the dashboard where the form is filled in.
      if (ans?.decision === "open" && click.dashboardUrl) run("open", click.dashboardUrl);
      return ans;
    },
  };
}
