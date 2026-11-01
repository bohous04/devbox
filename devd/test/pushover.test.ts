import { expect, test } from "bun:test";
import { createPushover, EMERGENCY } from "../src/pushover";

// Captures the bodies of POSTs to Pushover without a real network (send is fire-and-forget,
// it calls fetch synchronously before returning, so calls are filled immediately).
function withFetch(fn: () => void): { body: string }[] {
  const calls: { body: string }[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    calls.push({ body: init?.body?.toString() ?? "" });
    return new Response("{}");
  }) as typeof fetch;
  try { fn(); } finally { globalThis.fetch = orig; }
  return calls;
}

test("send without opts → normal priority (no priority/retry/expire)", () => {
  const calls = withFetch(() => { createPushover("tok", "usr").send("t", "m"); });
  expect(calls).toHaveLength(1);
  expect(calls[0].body).toContain("title=t");
  expect(calls[0].body).not.toContain("priority");
  expect(calls[0].body).not.toContain("retry");
});

test("EMERGENCY → priority=2 + retry + expire + loud sound", () => {
  const calls = withFetch(() => { createPushover("tok", "usr").send("t", "m", EMERGENCY); });
  const b = calls[0].body;
  expect(b).toContain("priority=2");
  expect(b).toContain("retry=60");
  expect(b).toContain("expire=3600");
  expect(b).toContain("sound=persistent");
});

test("url + url_title are passed into the body (deep link)", () => {
  const calls = withFetch(() => {
    createPushover("tok", "usr").send("shop/cms", "Claude is waiting for permission", { url: "https://dev.example.com/sessions?terminal=dev-shop-cms", url_title: "Open terminal" });
  });
  const b = calls[0].body;
  expect(b).toContain("url=https");
  expect(b).toContain("terminal%3Ddev-shop-cms");   // URLSearchParams encodes '='
  expect(b).toContain("url_title=Open+terminal");
});

test("unconfigured pushover is a no-op (no request, returns false)", () => {
  let ret = true;
  const calls = withFetch(() => { ret = createPushover(undefined, undefined).send("t", "m", EMERGENCY); });
  expect(ret).toBe(false);
  expect(calls).toHaveLength(0);
});
