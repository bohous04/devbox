import { expect, test } from "bun:test";
import { createCodexResetReader } from "../src/codexResets";
import { isCodexResetStatus, safeSourceUrl } from "../../shared/codexResets";
const status = { data: { latest_reset: null, scheduled_reset: null, active_watch: null }, meta: { generated_at: "2026-09-22T12:00:00Z" } };
test("reset reader deduplicates concurrent requests and caches results", async () => {
  let calls = 0; let time = 10;
  const read = createCodexResetReader((async () => { calls++; return Response.json(status); }) as unknown as typeof fetch, () => time);
  const [a, b] = await Promise.all([read(), read()]);
  expect(a).toEqual(b); expect(calls).toBe(1); expect(a.stale).toBe(false);
  await read(); expect(calls).toBe(1);
  time += 300_001; await read(); expect(calls).toBe(2);
});
test("reset outage preserves previous data and signals staleness", async () => {
  let time = 1; let calls = 0;
  const read = createCodexResetReader((async () => ++calls === 1 ? Response.json(status) : new Response("", { status: 503 })) as unknown as typeof fetch, () => time);
  await read(); time += 300_001;
  expect(await read()).toEqual({ status, fetchedAt: 1, stale: true });
});
test("reset reader respects retry-after and never presents malformed payloads", async () => {
  let time = 1; let calls = 0;
  const read = createCodexResetReader((async () => { calls++; return new Response("", { status: 429, headers: { "retry-after": "1200" } }); }) as unknown as typeof fetch, () => time);
  expect((await read()).status).toBeNull(); time += 600_000; await read(); expect(calls).toBe(1);
  expect(isCodexResetStatus({ ...status, data: { ...status.data, latest_reset: { text: "bad" } } })).toBe(false);
  expect(isCodexResetStatus(status)).toBe(true);
  expect(safeSourceUrl("javascript:alert(1)")).toBeUndefined();
  expect(safeSourceUrl("https://x.com/example/status/123")).toBe("https://x.com/example/status/123");
});
