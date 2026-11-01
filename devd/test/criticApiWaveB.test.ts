import { expect, test } from "bun:test";
import { createApp } from "../src/api";
import { openDb } from "../src/db";
import type { CodexAuthDeps } from "../src/agentAuth";

function app(codexAuth: Partial<Record<string, unknown>>, listener: unknown = {}) {
  const db = openDb(":memory:");
  const a = createApp({
    db, mgr: {} as never,
    cfg: { version: 1, settings: { autoStopHours: 4, portRangeStart: 40100, portsPerSession: 10, diskWarnPercent: 80 }, folders: {} },
    root: "/tmp", tree: async () => [], listener: listener as never, notify: () => {}, stats: () => ({ sessions: [], disk: {} }),
    cloneQueue: {} as never, configRepo: {} as never, dashboardDir: "/tmp",
    codexAuth: {
      run: async () => ({ code: 0, stdout: "", stderr: "" }),
      sleep: async () => {},
      ...codexAuth,
    } as CodexAuthDeps,
  } as never);
  return a;
}
const req = (path: string, method = "GET", body?: unknown) =>
  new Request(`http://x${path}`, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });

test("GET /api/auth returns the state of both providers, without tokens", async () => {
  const a = app({ run: async (cmd: string[]) => {
    if (cmd.join(" ").includes("codex login status")) return { code: 0, stdout: "Not logged in", stderr: "" };
    return { code: 0, stdout: "", stderr: "" }; // claude test -s exit 0
  }});
  const res = await a.fetch(req("/api/auth"));
  const body = await res.json() as { claude: { loggedIn: boolean }; codex: { loggedIn: boolean } };
  expect(res.status).toBe(200);
  expect(body.claude.loggedIn).toBe(true);
  expect(body.codex.loggedIn).toBe(false);
  expect(JSON.stringify(body)).not.toMatch(/sk-|token|credential/i);
});

test("POST /api/auth/codex/login/start returns url+code", async () => {
  const DEVICE = "https://auth.openai.com/codex/device ... OC4S-5ENNP";
  const a = app({ run: async (cmd: string[]) => {
    const s = cmd.join(" ");
    if (s.includes("run -d")) return { code: 0, stdout: "cid", stderr: "" };
    if (s.startsWith("logs")) return { code: 0, stdout: DEVICE, stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  }});
  const res = await a.fetch(req("/api/auth/codex/login/start", "POST"));
  const body = await res.json() as { url: string; code: string };
  expect(body.url).toContain("auth.openai.com/codex/device");
  expect(body.code).toBe("OC4S-5ENNP");
});



test("auth endpoints return 503 when codexAuth is not configured", async () => {
  const db = openDb(":memory:");
  const a = createApp({ db, mgr: {} as never, cfg: { version: 1, settings: { autoStopHours: 4, portRangeStart: 40100, portsPerSession: 10, diskWarnPercent: 80 }, folders: {} }, root: "/tmp", tree: async () => [], listener: {} as never, notify: () => {}, stats: () => ({ sessions: [], disk: {} }), cloneQueue: {} as never, configRepo: {} as never, dashboardDir: "/tmp" } as never);
  expect((await a.fetch(req("/api/auth"))).status).toBe(503);
});

test("POST /api/auth/proxy/xai/login/start returns the URL from the proxy log", async () => {
  const a = app({ run: async (cmd: string[]) => {
    const s = cmd.join(" ");
    if (s.includes("run -d")) return { code: 0, stdout: "cid", stderr: "" };
    if (s.startsWith("logs")) return { code: 0, stdout: "Open this URL: https://accounts.x.ai/oauth/x", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  }});
  const res = await a.fetch(req("/api/auth/proxy/xai/login/start", "POST"));
  const body = await res.json() as { url: string };
  expect(body.url).toContain("accounts.x.ai");
});

// The bridge on the mac (listener /proxy-bridge) is turned on right at login start, so the
// callback path is ready before the user clicks through OAuth. But its failure must not
// BLOCK the login — without the bridge a manual SSH tunnel still works, the dashboard just shows
// instructions. Hence the `bridge` field in the response instead of an error.
test("login/start reports bridge: ok when the listener built the bridge", async () => {
  const bridged: [number, number][] = [];
  const a = app({ run: async (cmd: string[]) => {
    const s = cmd.join(" ");
    if (s.includes("run -d")) return { code: 0, stdout: "cid", stderr: "" };
    if (s.startsWith("logs")) return { code: 0, stdout: "Open: https://accounts.x.ai/oauth/x", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  }}, { proxyBridge: async (ttl: number, port: number) => { bridged.push([ttl, port]); } });
  const body = await (await a.fetch(req("/api/auth/proxy/xai/login/start", "POST"))).json() as { url: string; bridge: string };
  expect(body.bridge).toBe("ok");
  expect(bridged.length).toBe(1);
});

test("login/start reports bridge: unavailable when the listener is down (login continues)", async () => {
  const a = app({ run: async (cmd: string[]) => {
    const s = cmd.join(" ");
    if (s.includes("run -d")) return { code: 0, stdout: "cid", stderr: "" };
    if (s.startsWith("logs")) return { code: 0, stdout: "Open: https://accounts.x.ai/oauth/x", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  }}, { proxyBridge: async () => { throw new Error("mac is asleep"); } });
  const res = await a.fetch(req("/api/auth/proxy/xai/login/start", "POST"));
  const body = await res.json() as { url: string; bridge: string };
  expect(res.status).toBe(200);
  expect(body.url).toContain("accounts.x.ai");
  expect(body.bridge).toBe("unavailable");
});

// The relay is wired to the login container's loopback — a path with a scheme or
// protocol-relative (`//host`) would turn it into an SSRF to anything.
test("GET /api/auth/proxy/relay rejects a path that does not start with a single slash", async () => {
  const a = app({});
  expect((await a.fetch(req("/api/auth/proxy/relay?path=http%3A%2F%2Fevil"))).status).toBe(400);
  expect((await a.fetch(req("/api/auth/proxy/relay?path=%2F%2Fevil"))).status).toBe(400);
  expect((await a.fetch(req("/api/auth/proxy/relay"))).status).toBe(400);
});

test("POST /api/auth/proxy/:provider/login/start: unknown provider → 400", async () => {
  const a = app({});
  const res = await a.fetch(req("/api/auth/proxy/gemini/login/start", "POST"));
  expect(res.status).toBe(400);
});

test("POST /api/auth/proxy/antigravity/login/start passes validation", async () => {
  const a = app({ run: async (cmd: string[]) => {
    const s = cmd.join(" ");
    if (s.includes("run -d")) return { code: 0, stdout: "cid", stderr: "" };
    if (s.startsWith("logs")) return { code: 0, stdout: "https://accounts.google.com/o/oauth2/v2/auth?state=x", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  }});
  const res = await a.fetch(req("/api/auth/proxy/antigravity/login/start", "POST"));
  expect(res.status).toBe(200);
});

test("GET /api/auth/proxy/codex/login/status: pending while the login container runs", async () => {
  const a = app({ run: async (cmd: string[]) => {
    const s = cmd.join(" ");
    if (s.startsWith("inspect")) return { code: 0, stdout: "running", stderr: "" };
    if (s.includes("ls /creds")) return { code: 1, stdout: "", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  }});
  const res = await a.fetch(req("/api/auth/proxy/codex/login/status"));
  expect(await res.json()).toEqual({ status: "pending" });
});

test("POST /api/auth/grok/login/start returns url+code from the device-auth log", async () => {
  const a = app({ run: async (cmd: string[]) => {
    const s = cmd.join(" ");
    if (s.includes("run -d")) return { code: 0, stdout: "cid", stderr: "" };
    if (s.startsWith("logs")) return { code: 0, stdout: "https://auth.x.ai/device AB3D-9F2K", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  }});
  const res = await a.fetch(req("/api/auth/grok/login/start", "POST"));
  const body = await res.json() as { url: string; code: string };
  expect(body.url).toBe("https://auth.x.ai/device");
  expect(body.code).toBe("AB3D-9F2K");
});

// Antigravity (agy): the code is validated BEFORE docker is touched at all — it goes into
// the login container's terminal as keystrokes, so a space/CR/escape would be commands.
test("POST /api/auth/antigravity/login/code: invalid code → 400 without docker", async () => {
  const calls: string[][] = [];
  const a = app({ run: async (cmd: string[]) => { calls.push(cmd); return { code: 0, stdout: "", stderr: "" }; } });
  for (const code of ["", "a b", "x\r", "\x1b[A"]) {
    const res = await a.fetch(req("/api/auth/antigravity/login/code", "POST", { code }));
    expect(res.status).toBe(400);
  }
  expect(calls).toHaveLength(0);
});

test("POST /api/auth/antigravity/login/code: valid code → 204, code only on stdin", async () => {
  const seen: { cmd: string[]; input?: string }[] = [];
  const a = app({ run: async (cmd: string[], input?: string) => { seen.push({ cmd, input }); return { code: 0, stdout: "", stderr: "" }; } });
  const res = await a.fetch(req("/api/auth/antigravity/login/code", "POST", { code: "4/0SECRET" }));
  expect(res.status).toBe(204);
  expect(seen.find((s) => s.cmd[0] === "exec")!.input).toBe("4/0SECRET");
});

test("GET /api/auth/antigravity/login/status: token in the volume → done", async () => {
  // Non-token branches MUST return 1 (container/inspect would otherwise never be needed for
  // "done" — a fake that always returns 0 would keep the test green even over an inverted `if`.
  const a = app({ run: async (cmd: string[]) => ({ code: cmd.join(" ").includes("antigravity-oauth-token") ? 0 : 1, stdout: "", stderr: "" }) });
  const res = await a.fetch(req("/api/auth/antigravity/login/status"));
  expect(await res.json()).toEqual({ status: "done" });
});

test("GET /api/auth/antigravity/login/status: no token + pane with a Google URL → pending", async () => {
  const pane = [
    " Your browser should open automatically. If not:",
    " https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=1071006060591-x.apps.googleusercontent.com&code_challenge=abc&code_challenge_method=S256&prompt=consent&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&response_type=code&scope=openid&state=pQrSOqJf3lI4sGPppnG7Ew",
    "",
    " If you aren't automatically redirected, paste the authorization code below:",
  ].join("\n");
  const a = app({ run: async (cmd: string[]) => {
    const s = cmd.join(" ");
    if (s.includes("antigravity-oauth-token")) return { code: 1, stdout: "", stderr: "" };
    if (s.startsWith("inspect")) return { code: 0, stdout: "running", stderr: "" };
    if (s.includes("capture-pane")) return { code: 0, stdout: pane, stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  } });
  const res = await a.fetch(req("/api/auth/antigravity/login/status"));
  expect(await res.json()).toEqual({ status: "pending" });
});

