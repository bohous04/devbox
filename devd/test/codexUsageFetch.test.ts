import { expect, test } from "bun:test";
import {
  USAGE_CANDIDATES, fetchCodexUsage, parseCodexAuthJson, usageHeaders, type CodexAuthTokens,
} from "../src/codexUsageFetch";

const tokens: CodexAuthTokens = {
  accessToken: "acc-1", accountId: "bc0e4093", idToken: null, lastRefresh: null,
};

const snapshot = { plan_type: "plus", primary: { used_percent: 5, window_minutes: 300, resets_at: 1_787_242_200 } };

const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const htmlRes = (status = 403) =>
  new Response("<html>bot check</html>", { status, headers: { "content-type": "text/html" } });

test("parseCodexAuthJson: extracts the tokens, nonsense → null", () => {
  const raw = JSON.stringify({
    auth_mode: "chatgpt", OPENAI_API_KEY: null, last_refresh: "2026-08-11T08:59:56Z",
    tokens: { access_token: "a", account_id: "b", id_token: "c", refresh_token: "d" },
  });
  expect(parseCodexAuthJson(raw)).toEqual({
    accessToken: "a", accountId: "b", idToken: "c", lastRefresh: "2026-08-11T08:59:56Z",
  });
  expect(parseCodexAuthJson("")).toBe(null);
  expect(parseCodexAuthJson("{}")).toBe(null);
  expect(parseCodexAuthJson(JSON.stringify({ tokens: {} }))).toBe(null);   // access_token missing
});

// Without these headers chatgpt.com answers with an HTML bot check; with them with JSON.
// Verified live 2026-08-20.
test("usageHeaders: carries the Codex CLI identity", () => {
  const h = usageHeaders(tokens);
  expect(h.Authorization).toBe("Bearer acc-1");
  expect(h["chatgpt-account-id"]).toBe("bc0e4093");
  expect(h.originator).toBe("codex_cli_rs");
});

test("fetchCodexUsage: tries the candidates in order, the first JSON wins", async () => {
  const tried: string[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    tried.push(`${init?.method ?? "GET"} ${String(url)}`);
    return tried.length < 3 ? htmlRes() : jsonRes(snapshot);
  }) as unknown as typeof fetch;

  const r = await fetchCodexUsage(tokens, f);
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.endpointIdx).toBe(2);
    expect(r.usage.windows[0].usedPct).toBe(5);
  }
  expect(tried).toHaveLength(3);
});

// The remembered index saves two needless requests on every poll — and above all two
// needless hits on the bot check, which could otherwise start behaving differently.
test("fetchCodexUsage: starts at the remembered index", async () => {
  const tried: string[] = [];
  const f = (async (url: string | URL | Request) => { tried.push(String(url)); return jsonRes(snapshot); }) as unknown as typeof fetch;
  const r = await fetchCodexUsage(tokens, f, 2);
  expect(r.ok).toBe(true);
  expect(tried).toEqual([USAGE_CANDIDATES[2].url]);
});

// JSON with an error code is NOT a success. This is exactly what the live account returns today.
test("fetchCodexUsage: non-2xx JSON → error code, not an empty quota", async () => {
  const f = (async () => jsonRes({ detail: { code: "deactivated_workspace" } }, 402)) as unknown as typeof fetch;
  const r = await fetchCodexUsage(tokens, f);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toBe("deactivated_workspace (HTTP 402)");
});

test("fetchCodexUsage: 200 with an unknown shape → unknown-shape", async () => {
  const f = (async () => jsonRes({ something: "else" })) as unknown as typeof fetch;
  const r = await fetchCodexUsage(tokens, f);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toContain("unknown-shape");
});

// I2: the remembered index is NOT an exclusive choice, just where to start. Without the tail,
// a move of the path on the OpenAI side after the first success would never fix itself.
test("fetchCodexUsage: the remembered index fails → tries the rest of the list, not just that one", async () => {
  let call = 0;
  const f = (async () => {
    call++;
    // idx1 (startIdx) fails on the network, only idx0 (the first of the rest) succeeds.
    if (call === 1) throw new Error("the endpoint has moved");
    return jsonRes(snapshot);
  }) as unknown as typeof fetch;
  const r = await fetchCodexUsage(tokens, f, 1);
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.endpointIdx).toBe(0);
  expect(call).toBe(2);
});

// I2: 404 is a moved path, try the next one — unlike 402/403, where another path
// would not help anyway (test below).
test("fetchCodexUsage: 404 continues to the next candidate", async () => {
  let call = 0;
  const f = (async () => {
    call++;
    return call === 1 ? jsonRes({ detail: { code: "not_found" } }, 404) : jsonRes(snapshot);
  }) as unknown as typeof fetch;
  const r = await fetchCodexUsage(tokens, f);
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.endpointIdx).toBe(1);
});

test("fetchCodexUsage: no candidate returned JSON → an error with the status codes", async () => {
  const f = (async () => htmlRes(403)) as unknown as typeof fetch;
  const r = await fetchCodexUsage(tokens, f);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toContain("403");
});

// Network errors (DNS, refused connection, timeout) must be logged so that it is
// known when the API has moved. If the error is swallowed, nobody notices.
test("fetchCodexUsage: fetch rejected → logs, tries the next candidates", async () => {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = ((msg: unknown) => { warnings.push(String(msg)); }) as typeof console.warn;

  try {
    let callCount = 0;
    const f = (async () => {
      callCount++;
      if (callCount === 1) throw new Error("connection refused");
      return jsonRes(snapshot);
    }) as unknown as typeof fetch;

    const r = await fetchCodexUsage(tokens, f);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.endpointIdx).toBe(1);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.some(w => w.includes("connection refused"))).toBe(true);
  } finally {
    console.warn = originalWarn;
  }
});
