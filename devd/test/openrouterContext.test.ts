import { expect, test } from "bun:test";
import { contextLengthCached, openrouterContextLength } from "../src/openrouterModels";

const payload = { data: [
  { id: "stealth/ox-alpha", context_length: 1048576 },
  { id: "mistralai/voxtral-small-24b-2507", context_length: 32000 },
] };

const okFetch = (async () => new Response(JSON.stringify(payload))) as unknown as typeof fetch;

test("returns the model's context_length from /v1/models", async () => {
  expect(await openrouterContextLength("stealth/ox-alpha", "https://openrouter.ai/api", okFetch)).toBe(1048576);
});

test("unknown model → null (no guess)", async () => {
  expect(await openrouterContextLength("no/such-model", "https://openrouter.ai/api", okFetch)).toBeNull();
});

test("HTTP error and a failed fetch → null, never throw", async () => {
  const err500 = (async () => new Response("err", { status: 500 })) as unknown as typeof fetch;
  const boom = (async () => { throw new Error("network down"); }) as unknown as typeof fetch;
  expect(await openrouterContextLength("stealth/ox-alpha", "u", err500)).toBeNull();
  expect(await openrouterContextLength("stealth/ox-alpha", "u", boom)).toBeNull();
});

// Cache: success is kept (no HTTP request on every session open), failure is
// NOT cached — after an OpenRouter outage the window is re-measured on the next open, not only after
// a devd restart.
test("a successful lookup is cached, a failed one is not", async () => {
  let calls = 0;
  const counting = (async () => { calls++; return new Response(JSON.stringify(payload)); }) as unknown as typeof fetch;
  const failing = (async () => { calls++; throw new Error("down"); }) as unknown as typeof fetch;
  const cache = new Map<string, number>();
  expect(await contextLengthCached("stealth/ox-alpha", "u", counting, cache)).toBe(1048576);
  expect(await contextLengthCached("stealth/ox-alpha", "u", counting, cache)).toBe(1048576);
  expect(calls).toBe(1);
  expect(await contextLengthCached("other/model", "u", failing, cache)).toBeNull();
  expect(await contextLengthCached("other/model", "u", failing, cache)).toBeNull();
  expect(calls).toBe(3);
});
