import { afterAll, expect, test } from "bun:test";
import { createListenerClient } from "../src/listener";

const received: { path: string; auth: string | null; kind: string }[] = [];
const fake = Bun.serve({
  port: 0,
  fetch: async (req) => {
    const url = new URL(req.url);
    const body = (await req.json()) as { path?: string };
    received.push({ path: body.path ?? "", auth: req.headers.get("authorization"), kind: url.pathname });
    return new Response(null, { status: 204 });
  },
});
afterAll(() => fake.stop(true));

test("open posts path with bearer token", async () => {
  const c = createListenerClient(`http://127.0.0.1:${fake.port}`, "tajny");
  await c.open("/srv/dev/a/b.md");
  expect(received[0]).toMatchObject({ kind: "/open", path: "/srv/dev/a/b.md", auth: "Bearer tajny" });
});

test("trailing slash in listener URL still hits /open, not //open", async () => {
  const c = createListenerClient(`http://127.0.0.1:${fake.port}/`, "tajny");
  await c.open("/srv/dev/a/b.md");
  expect(received.at(-1)).toMatchObject({ kind: "/open", path: "/srv/dev/a/b.md", auth: "Bearer tajny" });
});

test("unconfigured client: open throws, notify is silent no-op", async () => {
  const c = createListenerClient(undefined, undefined);
  await expect(c.open("/x")).rejects.toThrow(/not configured/);
  expect(() => c.notify("t", "m")).not.toThrow();
});

test("unreachable listener: open throws, notify swallows", async () => {
  const c = createListenerClient("http://127.0.0.1:1", "t", 300);
  await expect(c.open("/x")).rejects.toThrow();
  expect(() => c.notify("t", "m")).not.toThrow();
});

test("notify carries sound and session into the /notify body", async () => {
  const bodies: unknown[] = [];
  const srv = Bun.serve({ port: 0, fetch: async (req) => { bodies.push(await req.json()); return new Response(null, { status: 204 }); } });
  const client = createListenerClient(`http://127.0.0.1:${srv.port}`, "t");
  client.notify("shop/cms", "Claude is waiting for permission", { sound: true, session: { id: "dev-shop-cms", project: "shop", repo: "cms" } });
  await Bun.sleep(80);
  srv.stop(true);
  expect(bodies[0]).toEqual({
    title: "shop/cms", message: "Claude is waiting for permission",
    sound: true, session: { id: "dev-shop-cms", project: "shop", repo: "cms" },
  });
});

test("clipboard() GETs kind with the token and returns status+body+content-type", async () => {
  const calls: { path: string; auth: string | null }[] = [];
  const srv = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      calls.push({ path: url.pathname, auth: req.headers.get("authorization") });
      return new Response(new Uint8Array([9, 8, 7]), { status: 200, headers: { "content-type": "image/png" } });
    },
  });
  try {
    const c = createListenerClient(`http://127.0.0.1:${srv.port}`, "tok");
    const r = await c.clipboard("image");
    expect(calls[0]).toMatchObject({ path: "/clipboard/image", auth: "Bearer tok" });
    expect(r).toEqual({ status: 200, contentType: "image/png", body: new Uint8Array([9, 8, 7]) });
  } finally { srv.stop(true); }
});

test("clipboard() without configuration throws an error", async () => {
  const c = createListenerClient(undefined, undefined);
  await expect(c.clipboard("text")).rejects.toThrow(/listener is not configured/);
});

test("openUrl POSTs the url to /open-url with the token", async () => {
  const bodies: { url?: string }[] = []; const paths: string[] = [];
  const srv = Bun.serve({ port: 0, fetch: async (req) => { paths.push(new URL(req.url).pathname); bodies.push((await req.json()) as { url?: string }); return new Response(null, { status: 204 }); } });
  try {
    const c = createListenerClient(`http://127.0.0.1:${srv.port}`, "tok");
    await c.openUrl("http://100.64.0.10:40100/");
    expect(paths[0]).toBe("/open-url");
    expect(bodies[0]).toEqual({ url: "http://100.64.0.10:40100/" });
  } finally { srv.stop(true); }
});

test("openUrl without configuration throws an error", async () => {
  await expect(createListenerClient(undefined, undefined).openUrl("http://x")).rejects.toThrow(/not configured/);
});

/* ============================== sshApproval ============================== */

const ROW = {
  id: "abc", session_id: "dev-web-app", title: "shop", why: "restart hermes",
  target: "root@1.2.3.4", server: null, cwd: "/workspace", project: "web", repo: "app",
  status: "pending" as const, decided_by: null, created_at: 0, decided_at: null,
  expires_at: 0, grant_until: null, grant_permanent: 0 as const,
};

test("sshApproval POSTs the request to /ssh-approval and passes the decision to decide", async () => {
  const bodies: unknown[] = []; const paths: string[] = [];
  const srv = Bun.serve({
    port: 0,
    fetch: async (req) => {
      paths.push(new URL(req.url).pathname);
      bodies.push(await req.json());
      return Response.json({ decision: "approve", grantMinutes: 60 });
    },
  });
  try {
    const c = createListenerClient(`http://127.0.0.1:${srv.port}`, "tok");
    const decisions: unknown[] = [];
    await c.sshApproval(ROW, (d) => decisions.push(d));
    expect(paths[0]).toBe("/ssh-approval");
    expect(bodies[0]).toEqual({
      id: "abc", title: "shop", why: "restart hermes", target: "root@1.2.3.4", server: null,
      cwd: "/workspace", project: "web", repo: "app",
    });
    expect(decisions).toEqual([{ decision: "approve", grantMinutes: 60 }]);
  } finally { srv.stop(true); }
});

test("sshApproval: a closed dialog (204) does not call decide", async () => {
  const srv = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 204 }) });
  try {
    const c = createListenerClient(`http://127.0.0.1:${srv.port}`, "tok");
    let called = false;
    await c.sshApproval(ROW, () => { called = true; });
    expect(called).toBe(false);
  } finally { srv.stop(true); }
});

test("sshApproval without configuration does nothing and does not throw", async () => {
  let called = false;
  await createListenerClient(undefined, undefined).sshApproval(ROW, () => { called = true; });
  expect(called).toBe(false);
});

test("sshApproval: an unreachable Mac is fail-closed (does not throw, does not call decide)", async () => {
  let called = false;
  const c = createListenerClient("http://127.0.0.1:1", "t", 300);
  await c.sshApproval(ROW, () => { called = true; });
  expect(called).toBe(false);
});

test("Mac grant durations preserve 960 minutes, custom minutes, and explicit permanence", async () => {
  for (const answer of [
    { decision: "approve", grantMinutes: 960 },
    { decision: "approve", grantMinutes: 137 },
    { decision: "approve", grantMinutes: 0, grantPermanent: true },
  ]) {
    const srv = Bun.serve({ port: 0, fetch: () => Response.json(answer) });
    try {
      const c = createListenerClient(`http://127.0.0.1:${srv.port}`, "tok");
      const decisions: unknown[] = [];
      await c.sshApproval(ROW, (d) => decisions.push(d));
      expect(decisions).toEqual([answer]);
    } finally { srv.stop(true); }
  }
});

test("Mac malformed or conflicting durations do not approve anything", async () => {
  for (const duration of [
    { grantMinutes: -60 }, { grantMinutes: 1.5 }, { grantMinutes: "960" },
    { grantMinutes: null }, { grantMinutes: 1e300 },
    { grantPermanent: "true" }, { grantPermanent: 1 },
    { grantPermanent: true, grantMinutes: 60 },
  ]) {
    const srv = Bun.serve({ port: 0, fetch: () => Response.json({ decision: "approve", ...duration }) });
    try {
      const c = createListenerClient(`http://127.0.0.1:${srv.port}`, "tok");
      const decisions: unknown[] = [];
      await c.sshApproval(ROW, (d) => decisions.push(d));
      expect(decisions).toEqual([]);
    } finally { srv.stop(true); }
  }
});

test("a denial without grantMinutes stays valid", async () => {
  const srv = Bun.serve({ port: 0, fetch: () => Response.json({ decision: "deny" }) });
  try {
    const c = createListenerClient(`http://127.0.0.1:${srv.port}`, "tok");
    const decisions: unknown[] = [];
    await c.sshApproval(ROW, (d) => decisions.push(d));
    expect(decisions).toEqual([{ decision: "deny", grantMinutes: 0 }]);
  } finally { srv.stop(true); }
});

test("invalid/unknown decision (wrong type, forged value) — decide is not called at all", async () => {
  const srv = Bun.serve({ port: 0, fetch: () => Response.json({ decision: "maybe", grantMinutes: 60 }) });
  try {
    const c = createListenerClient(`http://127.0.0.1:${srv.port}`, "tok");
    let called = false;
    await c.sshApproval(ROW, () => { called = true; });
    expect(called).toBe(false);
  } finally { srv.stop(true); }
});

test("invalid JSON body (not an object) — decide is not called, does not throw", async () => {
  const srv = Bun.serve({ port: 0, fetch: () => Response.json("gibberish") });
  try {
    const c = createListenerClient(`http://127.0.0.1:${srv.port}`, "tok");
    let called = false;
    await expect(c.sshApproval(ROW, () => { called = true; })).resolves.toBeUndefined();
    expect(called).toBe(false);
  } finally { srv.stop(true); }
});
