import { expect, test } from "bun:test";
import { createApp } from "../src/api";
import { openDb } from "../src/db";
import { DEFAULT_DASHBOARD_ORIGINS, dashboardOrigins, originAllowed, stateChangingGetAllowed } from "../src/originGuard";

const DASH = "https://dev.example.com";
const PREVIEW = "https://p3.example.com";
const ENV = { DEVD_DASHBOARD_URL: `${DASH}/`, DEVD_BIND_IP: "100.64.0.10" };
const ALLOWED = dashboardOrigins(ENV);

const req = (method: string, headers: Record<string, string> = {}) => ({ method, headers: new Headers(headers) });

test("originAllowed: POST from a foreign Origin (preview p3) → rejected", () => {
  expect(originAllowed(req("POST", { origin: PREVIEW }), ALLOWED).ok).toBe(false);
});

test("originAllowed: POST from the dashboard (CF and tailnet) → passes", () => {
  expect(originAllowed(req("POST", { origin: DASH, "sec-fetch-site": "same-origin" }), ALLOWED)).toEqual({ ok: true });
  expect(originAllowed(req("DELETE", { origin: "http://100.64.0.10:4300" }), ALLOWED)).toEqual({ ok: true });
});

test("originAllowed: without Origin and Sec-Fetch-* (container, curl, iOS) → unchanged", () => {
  expect(originAllowed(req("POST"), ALLOWED)).toEqual({ ok: true });
  expect(originAllowed(req("GET", { upgrade: "websocket" }), ALLOWED)).toEqual({ ok: true });
});

test("originAllowed: WS upgrade with a foreign Origin → rejected, from the dashboard it passes", () => {
  expect(originAllowed(req("GET", { upgrade: "websocket", origin: PREVIEW }), ALLOWED).ok).toBe(false);
  expect(originAllowed(req("GET", { upgrade: "websocket", origin: DASH }), ALLOWED)).toEqual({ ok: true });
});

test("originAllowed: GET with a foreign Origin → passes (reads are covered by Access)", () => {
  expect(originAllowed(req("GET", { origin: PREVIEW, "sec-fetch-site": "same-site" }), ALLOWED)).toEqual({ ok: true });
});

test("originAllowed: browser without Origin — mutations only same-origin", () => {
  expect(originAllowed(req("POST", { "sec-fetch-site": "same-origin" }), ALLOWED)).toEqual({ ok: true });
  expect(originAllowed(req("POST", { "sec-fetch-site": "cross-site" }), ALLOWED).ok).toBe(false);
  expect(originAllowed(req("POST", { "sec-fetch-site": "same-site" }), ALLOWED).ok).toBe(false);
  expect(originAllowed(req("POST", { origin: "null" }), ALLOWED).ok).toBe(false);
});

test("dashboardOrigins: defaults + DEVD_DASHBOARD_ORIGINS (comma-separated, no trailing slash)", () => {
  // Final review I8: localhost:5173 (Vite) is NOT among the defaults — only via env.
  expect(dashboardOrigins({})).toEqual([...DEFAULT_DASHBOARD_ORIGINS]);
  expect(DEFAULT_DASHBOARD_ORIGINS).toEqual(["http://localhost:4300"]);
  // The dashboard's public URL and devd's tailnet address are derived from the install environment.
  const install = ["http://localhost:4300", "https://dev.example.com", "http://100.64.0.10:4300"];
  expect(dashboardOrigins(ENV)).toEqual(install);
  expect(dashboardOrigins({ ...ENV, DEVD_PORT: "4400" })).toContain("http://100.64.0.10:4400");
  expect(dashboardOrigins({ DEVD_DASHBOARD_URL: "not a url" })).toEqual([...DEFAULT_DASHBOARD_ORIGINS]);
  expect(dashboardOrigins({ ...ENV, DEVD_DASHBOARD_ORIGINS: " http://localhost:5173/ , ,https://x.example/" }))
    .toEqual([...install, "http://localhost:5173", "https://x.example"]);
});

function app() {
  const db = openDb(":memory:");
  return createApp({
    db, mgr: {} as never, cfg: { version: 1, settings: { autoStopHours: 4, portRangeStart: 40100, portsPerSession: 10, diskWarnPercent: 80 }, folders: {} },
    root: "/tmp", tree: async () => [], listener: {} as never, notify: () => {}, stats: () => ({ sessions: [], disk: {} }),
    cloneQueue: {} as never, configRepo: {} as never, dashboardDir: "/tmp",
    backup: { build: async () => "/nonexistent", restore: async () => {} },
    dashboardOrigins: ALLOWED,
  } as never);
}

const call = (path: string, init: RequestInit) => app().request(`http://x${path}`, init);
const JSON_CT = { "content-type": "application/json" };

test("API: POST from a preview → 403, from the dashboard → 200, from a container → 200", async () => {
  expect((await call("/api/stats/reset", { method: "POST", headers: { origin: PREVIEW } })).status).toBe(403);
  expect((await call("/api/stats/reset", { method: "POST", headers: { origin: DASH } })).status).toBe(200);
  expect((await call("/api/stats/reset", { method: "POST" })).status).toBe(200);
});

test("API: terminal WS upgrade with a foreign Origin → 403", async () => {
  const r = await call("/api/sessions/dev-a-b/terminal", { headers: { upgrade: "websocket", connection: "Upgrade", origin: PREVIEW } });
  expect(r.status).toBe(403);
});

test("API: GET with a foreign Origin → passes", async () => {
  expect((await call("/api/health", { headers: { origin: PREVIEW, "sec-fetch-site": "same-site" } })).status).toBe(200);
});

test("API: POST text/plain with a JSON body from a browser → 415; application/json passes", async () => {
  const body = JSON.stringify({});
  expect((await call("/api/stats/reset", { method: "POST", headers: { origin: DASH, "content-type": "text/plain" }, body })).status).toBe(415);
  expect((await call("/api/stats/reset", { method: "POST", headers: { origin: DASH, "content-type": "application/json; charset=utf-8" }, body })).status).toBe(200);
  expect((await call("/api/stats/reset", { method: "POST", headers: { origin: DASH, ...JSON_CT }, body })).status).toBe(200);
});

test("API: a container without Origin may send a body without JSON Content-Type (curl -d)", async () => {
  const r = await call("/api/stats/reset", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "{}" });
  expect(r.status).toBe(200);
});

test("API: /api/restore (backup upload) is exempt from the Content-Type rule, but Origin is checked", async () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const ok = await call("/api/restore", { method: "POST", headers: { origin: DASH, "content-type": "application/octet-stream" }, body: bytes });
  expect(ok.status).toBe(200);
  const foreign = await call("/api/restore", { method: "POST", headers: { origin: PREVIEW, "content-type": "application/octet-stream" }, body: bytes });
  expect(foreign.status).toBe(403);
});

test("stateChangingGetAllowed: same-site/cross-site and a foreign Origin → rejected; without Sec-Fetch-* or same-origin passes", () => {
  expect(stateChangingGetAllowed(req("GET", { "sec-fetch-site": "same-site" }), ALLOWED).ok).toBe(false);
  expect(stateChangingGetAllowed(req("GET", { "sec-fetch-site": "cross-site" }), ALLOWED).ok).toBe(false);
  expect(stateChangingGetAllowed(req("GET", { origin: PREVIEW }), ALLOWED).ok).toBe(false);
  expect(stateChangingGetAllowed(req("GET"), ALLOWED)).toEqual({ ok: true });
  expect(stateChangingGetAllowed(req("GET", { "sec-fetch-site": "same-origin", origin: DASH }), ALLOWED)).toEqual({ ok: true });
  expect(stateChangingGetAllowed(req("GET", { "sec-fetch-site": "none" }), ALLOWED)).toEqual({ ok: true });
});

test("API: GET /api/auth/proxy/relay from a preview (<img>, same-site) → 403; listener without Sec-Fetch-* passes the guard", async () => {
  const path = "/api/auth/proxy/relay?path=%2Fcallback%3Fcode%3Dx";
  expect((await call(path, { headers: { "sec-fetch-site": "same-site", "sec-fetch-dest": "image" } })).status).toBe(403);
  expect((await call(path, { headers: { "sec-fetch-site": "cross-site" } })).status).toBe(403);
  // Without Sec-Fetch-*: the guard lets it through, the handler tries the login container (not running in the test → 502, not 403).
  expect((await call(path, {})).status).not.toBe(403);
});

test("API: /v1/metrics from a preview → 403; OTel exporter without Origin (also protobuf) passes", async () => {
  const foreign = await call("/v1/metrics", { method: "POST", headers: { origin: PREVIEW, ...JSON_CT }, body: "{}" });
  expect(foreign.status).toBe(403);
  const otel = await call("/v1/metrics", { method: "POST", headers: JSON_CT, body: JSON.stringify({ resourceMetrics: [] }) });
  expect(otel.status).toBe(200);
  const proto = await call("/v1/metrics", { method: "POST", headers: { "content-type": "application/x-protobuf" }, body: new Uint8Array([1]) });
  expect(proto.status).toBe(200);
});
