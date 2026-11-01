import { expect, test } from "bun:test";
import {
  authStatus, codexLoginStart, codexLoginStatus, parseDeviceAuth, parseLoginStatus,
  grokLoginStart, grokLoginStatus, parseGrokDeviceAuth, parseOauthUrl,
  proxyLoginStart, proxyLoginStatus, isProxyProvider,
  agyLoginStart, agyLoginCode, agyLoginStatus, agyLogout, isValidAgyCode, parseAgyLoginUrl,
  type CodexAuthDeps,
} from "../src/agentAuth";

// The real device-auth log is COLORED (ANSI escape sequences) — the parser must cope with them.
const DEVICE_LOG = "\x1b[1mWelcome to Codex\x1b[0m\n\nFollow these steps...\n\n1. Open this link\n   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\n\n2. Enter this one-time code \x1b[90m(expires in 15 minutes)\x1b[0m\n   \x1b[94mOC4S-5ENNP\x1b[0m\n";

test("parseDeviceAuth extracts the URL and code even from a colored log", () => {
  const r = parseDeviceAuth(DEVICE_LOG);
  expect(r).toEqual({ url: "https://auth.openai.com/codex/device", code: "OC4S-5ENNP" });
});

test("parseDeviceAuth returns null when the code/URL is not in the log yet", () => {
  expect(parseDeviceAuth("Welcome to Codex\nstarting...")).toBeNull();
});

// Spinner log: cursor (\x1b[1A), erase-line (\x1b[2K) and hide/show (\x1b[?25l/h) sequences
// directly adjacent to the URL/code without a space — the old ANSI_RE (only "...m") did not catch them.
const SPINNER_LOG = "\x1b[?25l\x1b[2KOpen \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\n\x1b[1A\x1b[2K   \x1b[94mOC4S-5ENNP\x1b[0m\x1b[?25h\n";

test("parseDeviceAuth copes with spinner/cursor/erase CSI sequences, not just colors", () => {
  const r = parseDeviceAuth(SPINNER_LOG);
  expect(r).toEqual({ url: "https://auth.openai.com/codex/device", code: "OC4S-5ENNP" });
});

test("parseLoginStatus: 'Not logged in' → false, otherwise true", () => {
  expect(parseLoginStatus("Not logged in")).toBe(false);
  expect(parseLoginStatus("Logged in using ChatGPT (user@example.com)")).toBe(true);
});

test("parseLoginStatus: empty / unknown output → false (no false positive)", () => {
  expect(parseLoginStatus("")).toBe(false);
  expect(parseLoginStatus("exec: codex: not found")).toBe(false);
});

// Fake runner: maps a docker command → canonical output.
function fakeDeps(map: (cmd: string[], input?: string) => { code: number; stdout: string; stderr: string }): CodexAuthDeps {
  const calls: { cmd: string[]; input?: string }[] = [];
  const deps: CodexAuthDeps & { calls: typeof calls } = {
    run: async (cmd, input) => { calls.push({ cmd, input }); return map(cmd, input); },
    sleep: async () => {},
    calls,
  };
  return deps;
}

test("authStatus: claude file + codex status (live: 'Not logged in' on stderr, exit 1)", async () => {
  const deps = fakeDeps((cmd) => {
    if (cmd.includes("test") && cmd.join(" ").includes(".credentials.json")) return { code: 0, stdout: "", stderr: "" }; // claude logged in
    if (cmd.join(" ").includes("codex login status")) return { code: 1, stdout: "", stderr: "Not logged in" };
    // Antigravity is detected via `test -s …/antigravity-oauth-token` — the token is missing here.
    if (cmd.join(" ").includes("antigravity-oauth-token")) return { code: 1, stdout: "", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  });
  const s = await authStatus(deps);
  expect(s.claude.loggedIn).toBe(true);
  expect(s.codex.loggedIn).toBe(false);
  expect(s.codex.detail).toBe("not signed in");
  expect(s.antigravity.loggedIn).toBe(false);
  expect(s.antigravity.detail).toBe("not signed in");
});

test("authStatus: codex logged in via stderr even with exit 0", async () => {
  const deps = fakeDeps((cmd) => {
    if (cmd.includes("test") && cmd.join(" ").includes(".credentials.json")) return { code: 1, stdout: "", stderr: "" };
    if (cmd.join(" ").includes("codex login status")) return { code: 0, stdout: "", stderr: "Logged in using ChatGPT" };
    return { code: 0, stdout: "", stderr: "" };
  });
  const s = await authStatus(deps);
  expect(s.codex.loggedIn).toBe(true);
});

test("authStatus: codex genuinely unavailable (exec not found) ≠ logged out", async () => {
  const deps = fakeDeps((cmd) => {
    if (cmd.includes("test") && cmd.join(" ").includes(".credentials.json")) return { code: 1, stdout: "", stderr: "" };
    if (cmd.join(" ").includes("codex login status")) return { code: 127, stdout: "", stderr: "exec: codex: not found" };
    return { code: 0, stdout: "", stderr: "" };
  });
  const s = await authStatus(deps);
  expect(s.codex.loggedIn).toBe(false);
  expect(s.codex.detail).toContain("unavailable");
});

test("codexLoginStart: kills the old container, runs -d, polls the log, returns url+code", async () => {
  let logCalls = 0;
  const deps = fakeDeps((cmd) => {
    const s = cmd.join(" ");
    if (s.startsWith("rm -f")) return { code: 0, stdout: "", stderr: "" };
    if (s.includes("run -d")) return { code: 0, stdout: "containerid", stderr: "" };
    if (s.startsWith("logs")) { logCalls++; return { code: 0, stdout: logCalls >= 2 ? DEVICE_LOG : "starting", stderr: "" }; }
    return { code: 0, stdout: "", stderr: "" };
  });
  const r = await codexLoginStart(deps);
  expect(r.url).toBe("https://auth.openai.com/codex/device");
  expect(r.code).toBe("OC4S-5ENNP");
  expect(r.expiresInSec).toBe(900);
});

test("codexLoginStatus: running login container = pending; logged in = done", async () => {
  const pending = fakeDeps((cmd) => {
    const s = cmd.join(" ");
    if (s.startsWith("inspect")) return { code: 0, stdout: "running", stderr: "" };
    // live: "not logged in" goes to stderr with a nonzero exit code
    if (s.includes("codex login status")) return { code: 1, stdout: "", stderr: "Not logged in" };
    return { code: 0, stdout: "", stderr: "" };
  });
  expect(await codexLoginStatus(pending)).toBe("pending");

  const done = fakeDeps((cmd) => {
    const s = cmd.join(" ");
    if (s.startsWith("inspect")) return { code: 1, stdout: "", stderr: "No such container" }; // login container finished
    if (s.includes("codex login status")) return { code: 0, stdout: "", stderr: "Logged in using ChatGPT" };
    return { code: 0, stdout: "", stderr: "" };
  });
  expect(await codexLoginStatus(done)).toBe("done");
});


/* ============================== proxy (CLIProxyAPI) + Grok ============================== */

// The real CLIProxyAPI log is colored too — the same trap as with Codex (an ANSI escape
// sequence glued to the URL without a space).
const PROXY_LOG = "\x1b[94mOpen this URL:\x1b[0m https://accounts.x.ai/oauth/authorize?code=abc\n";

test("parseOauthUrl extracts the URL even from the colored proxy log, otherwise null", () => {
  expect(parseOauthUrl(PROXY_LOG)).toBe("https://accounts.x.ai/oauth/authorize?code=abc");
  expect(parseOauthUrl("nothing here")).toBeNull();
});

test("proxyLoginStart: login runs on the proxy volume and with --no-browser (the server has no browser)", async () => {
  const calls: string[][] = [];
  const deps = {
    run: async (cmd: string[]) => {
      calls.push(cmd);
      return { code: 0, stdout: "Open this URL: https://accounts.x.ai/oauth/authorize?code=abc", stderr: "" };
    },
    sleep: async () => {},
  };
  const r = await proxyLoginStart(deps as never, "xai");
  expect(r.url).toContain("accounts.x.ai");
  const runCmd = calls.find((c) => c.includes("-d"))!;
  expect(runCmd.join(" ")).toContain("cliproxy-auths");
  expect(runCmd.join(" ")).toContain("--xai-login");
  expect(runCmd.join(" ")).toContain("--no-browser");
});

test("proxyLoginStart: the codex provider picks --codex-login, not --xai-login", async () => {
  const calls: string[][] = [];
  const deps = fakeDeps((cmd) => {
    calls.push(cmd);
    if (cmd.includes("run") && cmd.includes("-d")) return { code: 0, stdout: "cid", stderr: "" };
    if (cmd[0] === "logs") return { code: 0, stdout: "Open this URL: https://accounts.openai.com/oauth/x", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  });
  const r = await proxyLoginStart(deps, "codex");
  expect(r.url).toContain("accounts.openai.com");
  const runCmd = calls.find((c) => c.includes("-d"))!;
  expect(runCmd.join(" ")).toContain("--codex-login");
  expect(runCmd.join(" ")).not.toContain("--xai-login");
});

// Image v7.2.137 (2026-08-19) lost its ENTRYPOINT — Cmd is ["./CLIProxyAPI"] and a bare
// `--codex-login` as the first arg is run by docker as a binary: exit 127, the container
// stays in the Created state and the dashboard shows HTTP 502. The login command therefore MUST
// name the binary explicitly, and also mount config.yaml (without it the binary immediately
// fails with "failed to load config") and publish callback port 1455 on the host loopback,
// so the OAuth redirect from the browser can be tunneled to it (SSH tunnel /
// listener bridge). All three measured live on the devbox 2026-08-23.
test("proxyLoginStart: runs an explicit binary with the config mount and callback port (image without ENTRYPOINT)", async () => {
  const calls: string[][] = [];
  const deps = fakeDeps((cmd) => {
    calls.push(cmd);
    if (cmd.includes("run") && cmd.includes("-d")) return { code: 0, stdout: "cid", stderr: "" };
    if (cmd[0] === "logs") return { code: 0, stdout: "Visit: https://auth.openai.com/oauth/authorize?x=1", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  });
  await proxyLoginStart(deps, "codex");
  const runCmd = calls.find((c) => c.includes("-d"))!;
  const s = runCmd.join(" ");
  // the binary explicitly BEFORE the flags — a flag must not be the container's first "command"
  expect(s).toContain("./CLIProxyAPI --codex-login");
  expect(s).toContain("/etc/devd/cliproxy/config.yaml:/CLIProxyAPI/config.yaml");
  expect(s).toContain("127.0.0.1:1455:1455");
});

test("proxyLoginStart: when the URL never shows up in the log, the container is cleaned up after the timeout", async () => {
  const rms: string[][] = [];
  const deps = fakeDeps((cmd) => {
    if (cmd[0] === "rm") rms.push(cmd);
    if (cmd.includes("run") && cmd.includes("-d")) return { code: 0, stdout: "cid", stderr: "" };
    if (cmd[0] === "logs") return { code: 0, stdout: "still waiting...", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  });
  await expect(proxyLoginStart(deps, "xai")).rejects.toThrow();
  // rm -f once before start and once after the timeout = cleaned up at both ends
  expect(rms.filter((c) => c.join(" ").includes("devbox-cliproxy-xai-login")).length).toBe(2);
});

test("proxyLoginStatus: running login container without credentials = pending; credentials in the volume = done", async () => {
  const pending = fakeDeps((cmd) => {
    const s = cmd.join(" ");
    if (s.startsWith("inspect")) return { code: 0, stdout: "running", stderr: "" };
    if (s.includes("ls /creds")) return { code: 1, stdout: "", stderr: "no match" };
    return { code: 0, stdout: "", stderr: "" };
  });
  expect(await proxyLoginStatus(pending, "xai")).toBe("pending");

  const done = fakeDeps((cmd) => {
    const s = cmd.join(" ");
    if (s.startsWith("inspect")) return { code: 1, stdout: "", stderr: "No such container" };
    if (s.includes("ls /creds")) return { code: 0, stdout: "xai-user@example.com.json\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  });
  expect(await proxyLoginStatus(done, "xai")).toBe("done");
});

test("proxyLoginStart(antigravity): --antigravity-login with callback port 1455", async () => {
  const deps = fakeDeps((cmd) => {
    const s = cmd.join(" ");
    if (s.includes("run -d")) return { code: 0, stdout: "cid", stderr: "" };
    if (s.startsWith("logs")) return { code: 0, stdout: "Visit the following URL to continue authentication:\nhttps://accounts.google.com/o/oauth2/v2/auth?redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Foauth-callback&state=x\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  });
  const r = await proxyLoginStart(deps, "antigravity");
  expect(r.url).toStartWith("https://accounts.google.com/o/oauth2/v2/auth?");
  const run = (deps as unknown as { calls: { cmd: string[] }[] }).calls.find((c) => c.cmd.includes("-d"))!.cmd;
  expect(run.slice(-5)).toEqual(["./CLIProxyAPI", "--antigravity-login", "--no-browser", "--oauth-callback-port", "1455"]);
});

test("proxyLoginStart(codex): argv unchanged, no port flag", async () => {
  const deps = fakeDeps((cmd) => {
    const s = cmd.join(" ");
    if (s.includes("run -d")) return { code: 0, stdout: "cid", stderr: "" };
    if (s.startsWith("logs")) return { code: 0, stdout: "https://auth.openai.com/oauth/authorize?x=1", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  });
  await proxyLoginStart(deps, "codex");
  const run = (deps as unknown as { calls: { cmd: string[] }[] }).calls.find((c) => c.cmd.includes("-d"))!.cmd;
  expect(run.slice(-3)).toEqual(["./CLIProxyAPI", "--codex-login", "--no-browser"]);
});

test("isProxyProvider", () => {
  for (const p of ["codex", "xai", "antigravity"]) expect(isProxyProvider(p)).toBe(true);
  for (const p of ["gemini", "", null, "__proto__"]) expect(isProxyProvider(p)).toBe(false);
});

test("proxyLoginStatus: container gone and no credentials = error, not a silent pending", async () => {
  const errored = fakeDeps((cmd) => {
    const s = cmd.join(" ");
    if (s.startsWith("inspect")) return { code: 1, stdout: "", stderr: "No such container" };
    if (s.includes("ls /creds")) return { code: 1, stdout: "", stderr: "no match" };
    return { code: 0, stdout: "", stderr: "" };
  });
  expect(await proxyLoginStatus(errored, "codex")).toBe("error");
});

// grok login --device-auth: the URL domain is NOT auth.openai.com (unlike Codex),
// so parseGrokDeviceAuth must not hard-wire the domain. The output shape is measured
// (three runs on grok 1.0.5, see the Grok research notes (2026-08-20),
// "Measured further 2026-08-20"), not guessed — see the MEASURED fixture below. This sample is
// deliberately colored and has a 4-5 code: it keeps coverage of the ANSI stripper and of a wider code shape
// that Grok might start sending without anyone announcing it.
const GROK_DEVICE_LOG = "\x1b[1mSign in to Grok\x1b[0m\n\x1b[94mhttps://auth.x.ai/device\x1b[0m\nEnter code: \x1b[94mAB3D-9F2K\x1b[0m\n";

// Verbatim shape of the measured output: code 4-4, domain accounts.x.ai, code twice (once
// in the URL query, once on its own), color only on the warning sentence.
const GROK_DEVICE_LOG_MEASURED =
  "\x1b[33mWarning: opening a browser is not possible\x1b[0m\n" +
  "Visit https://accounts.x.ai/oauth2/device?user_code=4HR3-QMWH to sign in.\n" +
  "Confirm this code: 4HR3-QMWH\n";

test("parseGrokDeviceAuth matches the ACTUALLY measured output of grok 1.0.5", () => {
  const r = parseGrokDeviceAuth(GROK_DEVICE_LOG_MEASURED);
  expect(r?.code).toBe("4HR3-QMWH");
  // The code is actually taken from `user_code=` in the URL (first occurrence), not from the "Confirm
  // this code" line — the value is the same in both places, so the result does not depend on it.
  expect(r?.url).toContain("accounts.x.ai");
  expect(r?.url).toContain("user_code=4HR3-QMWH");
});

test("parseGrokDeviceAuth extracts the URL and code from a colored log, without a hard-wired domain", () => {
  const r = parseGrokDeviceAuth(GROK_DEVICE_LOG);
  expect(r).toEqual({ url: "https://auth.x.ai/device", code: "AB3D-9F2K" });
});

test("parseGrokDeviceAuth returns null until both are in the log", () => {
  expect(parseGrokDeviceAuth("Signing in...")).toBeNull();
});

test("grokLoginStart: container on grok-home, grok login --device-auth, picks out url+code", async () => {
  let logCalls = 0;
  const calls: string[][] = [];
  const deps = fakeDeps((cmd) => {
    calls.push(cmd);
    const s = cmd.join(" ");
    if (s.startsWith("rm -f")) return { code: 0, stdout: "", stderr: "" };
    if (s.includes("run -d")) return { code: 0, stdout: "cid", stderr: "" };
    if (s.startsWith("logs")) { logCalls++; return { code: 0, stdout: logCalls >= 2 ? GROK_DEVICE_LOG : "starting", stderr: "" }; }
    return { code: 0, stdout: "", stderr: "" };
  });
  const r = await grokLoginStart(deps);
  expect(r.url).toBe("https://auth.x.ai/device");
  expect(r.code).toBe("AB3D-9F2K");
  // Review round 1, Minor: unlike Codex, NO made-up expiresInSec is returned —
  // the real validity period of the code was never measured (see the comment on the function).
  expect(r).not.toHaveProperty("expiresInSec");
  const runCmd = calls.find((c) => c.includes("-d"))!;
  expect(runCmd.join(" ")).toContain("grok-home");
  expect(runCmd.join(" ")).toContain("--device-auth");
});

test("grokLoginStatus: running container = pending; auth.json in the volume = done", async () => {
  const pending = fakeDeps((cmd) => {
    const s = cmd.join(" ");
    if (s.startsWith("inspect")) return { code: 0, stdout: "running", stderr: "" };
    if (s.includes("auth.json")) return { code: 1, stdout: "", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  });
  expect(await grokLoginStatus(pending)).toBe("pending");

  const done = fakeDeps((cmd) => {
    const s = cmd.join(" ");
    if (s.startsWith("inspect")) return { code: 1, stdout: "", stderr: "No such container" };
    if (s.includes("auth.json")) return { code: 0, stdout: "", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  });
  expect(await grokLoginStatus(done)).toBe("done");
});

test("grokLoginStatus: container gone and auth.json missing = error, not a silent pending", async () => {
  const errored = fakeDeps((cmd) => {
    const s = cmd.join(" ");
    if (s.startsWith("inspect")) return { code: 1, stdout: "", stderr: "No such container" };
    if (s.includes("auth.json")) return { code: 1, stdout: "", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  });
  expect(await grokLoginStatus(errored)).toBe("error");
});

test("grokLoginStart: when url+code never show up in the log, the container is cleaned up after the timeout", async () => {
  const rms: string[][] = [];
  const deps = fakeDeps((cmd) => {
    if (cmd[0] === "rm") rms.push(cmd);
    if (cmd.includes("run") && cmd.includes("-d")) return { code: 0, stdout: "cid", stderr: "" };
    if (cmd[0] === "logs") return { code: 0, stdout: "still waiting...", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  });
  await expect(grokLoginStart(deps)).rejects.toThrow();
  // rm -f once before start and once after the timeout = cleaned up at both ends
  expect(rms.filter((c) => c.join(" ").includes("devbox-grok-login")).length).toBe(2);
});


test("authStatus: also reports proxy accounts and Grok by the presence of credentials in the volume", async () => {
  const deps = fakeDeps((cmd) => {
    const s = cmd.join(" ");
    if (cmd.includes("test") && s.includes(".credentials.json")) return { code: 1, stdout: "", stderr: "" };
    if (s.includes("codex login status")) return { code: 1, stdout: "", stderr: "Not logged in" };
    if (s.includes("ls /creds/codex-")) return { code: 0, stdout: "codex-user.json\n", stderr: "" };
    if (s.includes("ls /creds/xai-")) return { code: 1, stdout: "", stderr: "" };
    if (s.includes("auth.json") || s.includes(".xai_api_key")) return { code: 1, stdout: "", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  });
  const status = await authStatus(deps);
  expect(status.proxyCodex.loggedIn).toBe(true);
  expect(status.proxyXai.loggedIn).toBe(false);
  expect(status.grok.loggedIn).toBe(false);
});

test("authStatus: docker containers run concurrently, not one after another", async () => {
  let running = 0, peak = 0;
  const deps: CodexAuthDeps = {
    run: async () => {
      running++; peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return { code: 1, stdout: "", stderr: "" };
    },
    sleep: async () => {},
  };
  await authStatus(deps);
  expect(peak).toBe(7); // claude, codex, proxyCodex, proxyXai, proxyAntigravity, grok, antigravity
});

/* ============================== Antigravity (agy) ============================== */

const AGY_PANE = [
  " Your browser should open automatically. If not:",
  " https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=1071006060591-x.apps.googleusercontent.com&code_challenge=abc&code_challenge_method=S256&prompt=consent&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&response_type=code&scope=openid&state=pQrSOqJf3lI4sGPppnG7Ew",
  "",
  " If you aren't automatically redirected, paste the authorization code below:",
].join("\n");

test("parseAgyLoginUrl extracts the whole Google URL from the pane", () => {
  expect(parseAgyLoginUrl(AGY_PANE)).toStartWith("https://accounts.google.com/o/oauth2/auth?access_type=offline");
  expect(parseAgyLoginUrl(AGY_PANE)).toEndWith("state=pQrSOqJf3lI4sGPppnG7Ew");
  expect(parseAgyLoginUrl(" Select login method:\n > 1. Google OAuth")).toBeNull();
});

test("isValidAgyCode: only printable characters without spaces, ≤ 512", () => {
  expect(isValidAgyCode("4/0AXlqoi6uPOnt4E9dUjKslVq")).toBe(true);
  for (const bad of ["", "a b", "abc\r", "abc\n", "\x1b[A", "x".repeat(513), 42, null]) expect(isValidAgyCode(bad)).toBe(false);
});

test("agyLoginStart: container on antigravity-home, Enter in the menu, URL from the pane", async () => {
  let captures = 0;
  const deps = fakeDeps((cmd) => {
    const s = cmd.join(" ");
    if (s.includes("capture-pane")) { captures++; return { code: 0, stdout: captures < 2 ? " Select login method:\n > 1. Google OAuth" : AGY_PANE, stderr: "" }; }
    if (s.includes("run -d")) return { code: 0, stdout: "cid", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  });
  const r = await agyLoginStart(deps);
  expect(r.url).toEndWith("state=pQrSOqJf3lI4sGPppnG7Ew");
  const calls = (deps as unknown as { calls: { cmd: string[] }[] }).calls.map((c) => c.cmd.join(" "));
  expect(calls[0]).toBe("rm -f devbox-agy-login");
  const runCmd = calls.find((c) => c.includes("run -d"))!;
  expect(runCmd).toContain("antigravity-home:/home/dev/.gemini");
  expect(runCmd).toContain("tmux new-session -d -x 1000 -y 50 agy; exec sleep 900");
  expect(calls.some((c) => c.includes("send-keys Enter"))).toBe(true);
});

test("agyLoginStart: URL never appears → container removed and an error", async () => {
  const deps = fakeDeps((cmd) => cmd.join(" ").includes("run -d") ? { code: 0, stdout: "cid", stderr: "" } : { code: 0, stdout: "", stderr: "" });
  await expect(agyLoginStart(deps)).rejects.toThrow(/URL/);
  const calls = (deps as unknown as { calls: { cmd: string[] }[] }).calls.map((c) => c.cmd.join(" "));
  expect(calls.at(-1)).toBe("rm -f devbox-agy-login");
});

test("agyLoginCode: code only on docker exec -i stdin, never in argv", async () => {
  const deps = fakeDeps(() => ({ code: 0, stdout: "", stderr: "" }));
  await agyLoginCode(deps, "4/0SECRETCODE");
  const calls = (deps as unknown as { calls: { cmd: string[]; input?: string }[] }).calls;
  const exec = calls.find((c) => c.cmd[0] === "exec")!;
  expect(exec.cmd.slice(0, 3)).toEqual(["exec", "-i", "devbox-agy-login"]);
  expect(exec.input).toBe("4/0SECRETCODE");
  for (const c of calls) expect(c.cmd.join(" ")).not.toContain("SECRETCODE");
});

test("agyLoginCode: an invalid code throws without docker and without the code in the message", async () => {
  const deps = fakeDeps(() => ({ code: 0, stdout: "", stderr: "" }));
  await expect(agyLoginCode(deps, "bad code\r")).rejects.toThrow(/invalid/);
  expect((deps as unknown as { calls: unknown[] }).calls).toHaveLength(0);
});

test("agyLoginStatus: token = done (and container removed); running = pending; error in the pane or a vanished container = error", async () => {
  const mk = (token: boolean, state: string, pane = "") => fakeDeps((cmd) => {
    const s = cmd.join(" ");
    if (s.includes("antigravity-oauth-token")) return { code: token ? 0 : 1, stdout: "", stderr: "" };
    if (s.startsWith("inspect")) return state ? { code: 0, stdout: state, stderr: "" } : { code: 1, stdout: "", stderr: "No such container" };
    if (s.includes("capture-pane")) return { code: 0, stdout: pane, stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  });
  const done = mk(true, "running");
  expect(await agyLoginStatus(done)).toBe("done");
  expect((done as unknown as { calls: { cmd: string[] }[] }).calls.some((c) => c.cmd.join(" ") === "rm -f devbox-agy-login")).toBe(true);
  expect(await agyLoginStatus(mk(false, "running", AGY_PANE))).toBe("pending");
  expect(await agyLoginStatus(mk(false, "running", ' Got an error: token exchange failed: oauth2: "invalid_grant"\n Press any key to go back.'))).toBe("error");
  expect(await agyLoginStatus(mk(false, ""))).toBe("error");
});

// agy can crash such that the tmux session disappears, but `sleep 900` in the entrypoint keeps the container
// alive — `inspect` then still reports "running". Without this layer capture-pane
// (exit != 0, "can't find session") would end with an empty stdout, `/Got an error:/` would
// not match, and agyLoginStatus would report "pending" for the full 15 minutes instead of "error" right away.
test("agyLoginStatus: capture-pane fails (agy crashed, container still running) → error and container cleanup", async () => {
  const deps = fakeDeps((cmd) => {
    const s = cmd.join(" ");
    if (s.includes("antigravity-oauth-token")) return { code: 1, stdout: "", stderr: "" };
    if (s.startsWith("inspect")) return { code: 0, stdout: "running", stderr: "" };
    if (s.includes("capture-pane")) return { code: 1, stdout: "", stderr: "can't find session" };
    return { code: 0, stdout: "", stderr: "" };
  });
  expect(await agyLoginStatus(deps)).toBe("error");
  expect((deps as unknown as { calls: { cmd: string[] }[] }).calls.some((c) => c.cmd.join(" ") === "rm -f devbox-agy-login")).toBe(true);
});

test("agyLogout deletes the token and the onboarding marker, reads nothing", async () => {
  const deps = fakeDeps(() => ({ code: 0, stdout: "", stderr: "" }));
  await agyLogout(deps);
  const s = (deps as unknown as { calls: { cmd: string[] }[] }).calls.map((c) => c.cmd.join(" ")).join("\n");
  expect(s).toContain("antigravity-home:/home/dev/.gemini");
  expect(s).toContain("rm -f /home/dev/.gemini/antigravity-cli/antigravity-oauth-token /home/dev/.gemini/antigravity-cli/.devbox-onboarded");
  expect(s).not.toMatch(/\bcat\b/);
});
