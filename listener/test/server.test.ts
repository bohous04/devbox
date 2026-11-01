import { expect, test } from "bun:test";
import { createListener, allowedPreviewUrl } from "../src/server";
import type { Actions } from "../src/actions";
import type { SshApprovalReq } from "../src/sshPrompt";

const cfg = { token: "secret", host: "127.0.0.1", port: 7777, mappings: [{ from: "/srv/dev", to: "/Volumes/dev" }] };
function fixture() {
  const opened: string[] = []; const notified: [string, string, unknown][] = [];
  const focused: string[] = []; const attached: string[] = []; let dashboardOpened = 0;
  let focusHit = false;
  let clipTargets: string[] = []; let clipImage: Uint8Array | null = null; let clipText: string | null = null;
  let clipFile: { name: string; bytes: Uint8Array } | { tooBig: true } | null = null;
  const bridges: [string, number][] = []; let bridgeOk = true;
  const sshAsked: SshApprovalReq[] = [];
  let sshAnswer: { decision: "approve" | "deny"; grantMinutes: number } | null = null;
  const actions: Actions = {
    startProxyBridge: (base, ttl) => { if (bridgeOk) bridges.push([base, ttl]); return { ok: bridgeOk }; },
    open: (p) => { opened.push(p); return { code: 0 }; },
    openUrl: (u) => { opened.push(u); return { code: 0 }; },
    notify: (t, m, o) => { notified.push([t, m, o]); return { code: 0 }; },
    focusWarp: (n) => { focused.push(n); return focusHit; },
    openWarpAttach: (id) => { attached.push(id); return { code: 0 }; },
    openDashboard: () => { dashboardOpened++; return { code: 0 }; },
    clipboardTargets: () => clipTargets,
    clipboardImage: () => clipImage,
    clipboardText: () => clipText,
    clipboardFile: () => clipFile,
    askDbRequest: async () => null,
    askSshApproval: async (req) => { sshAsked.push(req); return sshAnswer; },
  };
  return {
    app: createListener(cfg, actions), opened, notified, focused, attached, dashboard: () => dashboardOpened,
    bridges, setBridgeOk: (v: boolean) => { bridgeOk = v; },
    setFocusHit: (v: boolean) => { focusHit = v; },
    setClip: (t: string[], i: Uint8Array | null, x: string | null) => { clipTargets = t; clipImage = i; clipText = x; },
    setClipFile: (f: { name: string; bytes: Uint8Array } | { tooBig: true } | null) => { clipFile = f; },
    sshAsked, setSshAnswer: (a: { decision: "approve" | "deny"; grantMinutes: number } | null) => { sshAnswer = a; },
  };
}
const post = (app: { fetch(r: Request): Promise<Response> }, path: string, body: unknown, token?: string) =>
  app.fetch(new Request(`http://x${path}`, {
    method: "POST", body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
  }));

test("open happy path maps and opens", async () => {
  const { app, opened } = fixture();
  const res = await post(app, "/open", { path: "/srv/dev/a/b.md" }, "secret");
  expect(res.status).toBe(204);
  expect(opened).toEqual(["/Volumes/dev/a/b.md"]);
});

test("auth and mapping failures", async () => {
  const { app, opened } = fixture();
  expect((await post(app, "/open", { path: "/srv/dev/a" })).status).toBe(401);
  expect((await post(app, "/open", { path: "/srv/dev/a" }, "spatny")).status).toBe(401);
  expect((await post(app, "/open", { path: "/etc/passwd" }, "secret")).status).toBe(403);
  expect((await post(app, "/open", { nope: 1 }, "secret")).status).toBe(400);
  expect(opened).toEqual([]);
});

test("open rejects path traversal with 403 and does not open", async () => {
  const { app, opened } = fixture();
  expect((await post(app, "/open", { path: "/srv/dev/../etc" }, "secret")).status).toBe(403);
  expect(opened).toEqual([]);
});

test("notify forwards and health needs no auth", async () => {
  const { app, notified } = fixture();
  expect((await post(app, "/notify", { title: "devbox", message: "hello" }, "secret")).status).toBe(204);
  expect(notified).toEqual([["devbox", "hello", { sound: false, session: undefined }]]);
  expect((await app.fetch(new Request("http://x/health"))).status).toBe(200);
});

test("notify forwards sound and session; an invalid session is dropped", async () => {
  const { app, notified } = fixture();
  expect((await post(app, "/notify", { title: "⏸️ a/b", message: "m", sound: true, session: { id: "dev-a-b", project: "a", repo: "b" } }, "secret")).status).toBe(204);
  expect(notified[0]).toEqual(["⏸️ a/b", "m", { sound: true, session: { id: "dev-a-b", project: "a", repo: "b" } }]);
  expect((await post(app, "/notify", { title: "t", message: "m", session: { id: "../x", project: "a", repo: "b" } }, "secret")).status).toBe(204);
  expect(notified[1]).toEqual(["t", "m", { sound: false, session: undefined }]);
});

test("open action failure surfaces as 500 with an error body", async () => {
  const actions: Actions = {
    open: () => ({ code: 1 }),
    openUrl: () => ({ code: 0 }),
    startProxyBridge: () => ({ ok: true }),
    notify: () => ({ code: 0 }),
    focusWarp: () => false,
    openWarpAttach: () => ({ code: 0 }),
    openDashboard: () => ({ code: 0 }),
    clipboardTargets: () => [],
    clipboardImage: () => null,
    clipboardText: () => null,
    clipboardFile: () => null,
    askDbRequest: async () => null,
    askSshApproval: async () => null,
  };
  const app = createListener(cfg, actions);
  const res = await post(app, "/open", { path: "/srv/dev/a/b.md" }, "secret");
  expect(res.status).toBe(500);
  expect(await res.json()).toEqual({ error: "open failed" });
});

test("clicked: session → focus, on miss a new tab; no session → dashboard; auth", async () => {
  const f = fixture();
  expect((await post(f.app, "/clicked", { id: "dev-shop-cms", project: "shop", repo: "cms" })).status).toBe(401); // no token
  f.setFocusHit(true);
  expect((await post(f.app, "/clicked", { id: "dev-shop-cms", project: "shop", repo: "cms" }, "secret")).status).toBe(204);
  expect(f.focused).toEqual(["cms"]);
  expect(f.attached).toEqual([]);
  f.setFocusHit(false);
  await post(f.app, "/clicked", { id: "dev-shop-cms", project: "shop", repo: "cms" }, "secret");
  expect(f.attached).toEqual(["dev-shop-cms"]);
  await post(f.app, "/clicked", {}, "secret");
  expect(f.dashboard()).toBe(1);
});

const get = (app: { fetch(r: Request): Promise<Response> }, path: string, token?: string) =>
  app.fetch(new Request(`http://x${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} }));

test("clipboard targets/image/text return the clipboard contents", async () => {
  const { app, setClip } = fixture();
  setClip(["image/png", "text/plain"], new Uint8Array([1, 2, 3]), "hello");
  const t = await get(app, "/clipboard/targets", "secret");
  expect(t.status).toBe(200);
  expect(await t.text()).toBe("image/png\ntext/plain\n");
  const i = await get(app, "/clipboard/image", "secret");
  expect(i.status).toBe(200);
  expect(i.headers.get("content-type")).toBe("image/png");
  expect(new Uint8Array(await i.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  const x = await get(app, "/clipboard/text", "secret");
  expect(x.status).toBe(200);
  expect(await x.text()).toBe("hello");
});

test("clipboard: empty clipboard → 204, no token 401, unknown kind 404", async () => {
  const { app } = fixture(); // clip* empty by default
  expect((await get(app, "/clipboard/targets", "secret")).status).toBe(204);
  expect((await get(app, "/clipboard/image", "secret")).status).toBe(204);
  expect((await get(app, "/clipboard/text", "secret")).status).toBe(204);
  expect((await get(app, "/clipboard/image")).status).toBe(401);
  expect((await get(app, "/clipboard/image", "spatny")).status).toBe(401);
  expect((await get(app, "/clipboard/gif", "secret")).status).toBe(404);
});

test("clipboard/file: returns bytes + x-devbox-filename", async () => {
  const { app, setClipFile } = fixture();
  setClipFile({ name: "café menu.pdf", bytes: new Uint8Array([1, 2, 3]) });
  const r = await get(app, "/clipboard/file", "secret");
  expect(r.status).toBe(200);
  expect(r.headers.get("content-type")).toBe("application/octet-stream");
  expect(decodeURIComponent(r.headers.get("x-devbox-filename")!)).toBe("café menu.pdf");
  expect(new Uint8Array(await r.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
});

test("clipboard/file: empty → 204, over the cap → 413, no token → 401", async () => {
  const { app, setClipFile } = fixture();
  expect((await get(app, "/clipboard/file", "secret")).status).toBe(204); // clipFile null by default
  setClipFile({ tooBig: true });
  expect((await get(app, "/clipboard/file", "secret")).status).toBe(413);
  expect((await get(app, "/clipboard/file")).status).toBe(401);
});

test("allowedPreviewUrl lets through only tailnet/private http", () => {
  expect(allowedPreviewUrl("http://100.64.0.10:40100/")).toBe("http://100.64.0.10:40100/");
  expect(allowedPreviewUrl("http://127.0.0.1:3000")).toBe("http://127.0.0.1:3000/");
  expect(allowedPreviewUrl("http://devbox.tail1234.ts.net:40100/x")).toBe("http://devbox.tail1234.ts.net:40100/x");
  expect(allowedPreviewUrl("http://93.184.216.34/")).toBeNull();
  expect(allowedPreviewUrl("file:///etc/passwd")).toBeNull();
  expect(allowedPreviewUrl("javascript:alert(1)")).toBeNull();
  expect(allowedPreviewUrl("nonsense")).toBeNull();
});

test("/open-url opens an allowed URL, blocks a disallowed one and checks the token", async () => {
  const { app, opened } = fixture();
  expect((await post(app, "/open-url", { url: "http://100.64.0.10:40100" })).status).toBe(401);
  expect((await post(app, "/open-url", { url: "http://100.64.0.10:40100" }, "secret")).status).toBe(204);
  expect(opened).toEqual(["http://100.64.0.10:40100/"]);
  expect((await post(app, "/open-url", { url: "file:///etc/passwd" }, "secret")).status).toBe(400);
  expect((await post(app, "/open-url", { nope: 1 }, "secret")).status).toBe(400);
});

/* ============================== proxy-bridge (OAuth callback) ============================== */

// Bridge for the proxy login's OAuth callback: the browser on the Mac is redirected to
// http://localhost:1455/…, but the login container with that port runs on the VPS.
// /proxy-bridge tells the listener "open 127.0.0.1:1455 for 15 minutes and forward
// to the devd relay". The target is built from relayHost (request body, otherwise devd's
// source IP) + relayPort — and it MUST pass the same network filter as /open-url, so
// a compromised devd cannot use the Mac as a relay to an arbitrary public host.
test("proxy-bridge: starts the bridge to the relay base from the body and returns 204", async () => {
  const { app, bridges } = fixture();
  const res = await post(app, "/proxy-bridge", { relayHost: "100.64.0.10", relayPort: 4300, ttlSec: 900 }, "secret");
  expect(res.status).toBe(204);
  expect(bridges).toEqual([["http://100.64.0.10:4300", 900_000]]);
});

test("proxy-bridge: without relayHost it takes the request source address (the path from devd works back too)", async () => {
  const { app, bridges } = fixture();
  const res = await app.fetch(new Request("http://x/proxy-bridge", {
    method: "POST", body: JSON.stringify({ relayPort: 4300 }),
    headers: { "content-type": "application/json", authorization: "Bearer secret" },
  }), { requestIP: () => ({ address: "100.64.0.10" }) } as never);
  expect(res.status).toBe(204);
  expect(bridges).toEqual([["http://100.64.0.10:4300", 900_000]]);
});

test("proxy-bridge: a public host does not pass (same filter as /open-url), no source 400", async () => {
  const { app, bridges } = fixture();
  expect((await post(app, "/proxy-bridge", { relayHost: "8.8.8.8", relayPort: 4300 }, "secret")).status).toBe(400);
  expect((await post(app, "/proxy-bridge", { relayPort: 4300 }, "secret")).status).toBe(400);
  expect((await post(app, "/proxy-bridge", { relayHost: "100.64.0.10" }, "spatny")).status).toBe(401);
  expect(bridges).toEqual([]);
});

test("proxy-bridge: port 1455 in use returns 409 so the dashboard can suggest a tunnel", async () => {
  const { app, setBridgeOk } = fixture();
  setBridgeOk(false);
  const res = await post(app, "/proxy-bridge", { relayHost: "100.64.0.10", relayPort: 4300 }, "secret");
  expect(res.status).toBe(409);
});

/* ============================== ssh-approval ============================== */

test("ssh-approval: sends the request to the dialog and returns the decision", async () => {
  const { app, sshAsked, setSshAnswer } = fixture();
  setSshAnswer({ decision: "approve", grantMinutes: 60 });
  const res = await post(app, "/ssh-approval", {
    id: "abc", title: "shop", why: "restart hermes", target: "root@1.2.3.4", cwd: "/workspace", project: "web", repo: "app",
  }, "secret");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ decision: "approve", grantMinutes: 60 });
  expect(sshAsked).toEqual([{
    id: "abc", title: "shop", why: "restart hermes", target: "root@1.2.3.4", cwd: "/workspace", project: "web", repo: "app",
  }]);
});

test("ssh-approval: a closed/unintelligible dialog returns 204 (fail-closed)", async () => {
  const { app } = fixture(); // sshAnswer null by default
  const res = await post(app, "/ssh-approval", { id: "abc", title: "shop", why: "restart hermes" }, "secret");
  expect(res.status).toBe(204);
});

test("ssh-approval: missing id/title/why → 400, no token → 401", async () => {
  const { app } = fixture();
  expect((await post(app, "/ssh-approval", { title: "shop", why: "x" }, "secret")).status).toBe(400);
  expect((await post(app, "/ssh-approval", { id: "abc", why: "x" }, "secret")).status).toBe(400);
  expect((await post(app, "/ssh-approval", { id: "abc", title: "shop" }, "secret")).status).toBe(400);
  expect((await post(app, "/ssh-approval", { id: "abc", title: "shop", why: "x" })).status).toBe(401);
});
