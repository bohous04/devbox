import { expect, test } from "bun:test";
import { agyTokenStale, agyUserAgent, fetchAgyQuota, parseAgyToken, parseQuotaSummary } from "../src/antigravityUsageFetch";

test("parseAgyToken: Go oauth2.Token JSON and camelCase (flat); otherwise null", () => {
  expect(parseAgyToken(JSON.stringify({ access_token: "ya29.x", token_type: "Bearer", refresh_token: "1//r", expiry: "2026-10-15T12:00:00Z" })))
    .toEqual({ accessToken: "ya29.x", expiresAt: Date.parse("2026-10-15T12:00:00Z") });
  expect(parseAgyToken(JSON.stringify({ accessToken: "ya29.y" }))).toEqual({ accessToken: "ya29.y", expiresAt: null });
  for (const bad of ["", "{", "[]", JSON.stringify({ token: 1 })]) expect(parseAgyToken(bad)).toBeNull();
});

// The live-measured shape of the real agy file (Questions 7–11, the Antigravity research notes):
// the Go oauth2.Token is NESTED under "token", expiry carries nanoseconds + offset.
test("parseAgyToken: the real file shape — oauth2.Token nested under \"token\"", () => {
  const raw = JSON.stringify({
    auth_method: "consumer",
    id_token: "jwt.secret.stuff",
    token: {
      access_token: "ya29.NESTED",
      expiry: "2026-10-15T12:35:48.797581716+02:00",
      refresh_token: "1//nested-refresh",
      token_type: "Bearer",
    },
  });
  expect(parseAgyToken(raw)).toEqual({ accessToken: "ya29.NESTED", expiresAt: Date.parse("2026-10-15T12:35:48.797581716+02:00") });
});

test("agyTokenStale: expired (with a 60s margin) = true, unknown expiry = false", () => {
  const now = Date.parse("2026-10-15T12:00:00Z");
  expect(agyTokenStale({ accessToken: "a", expiresAt: now + 30_000 }, now)).toBe(true);
  expect(agyTokenStale({ accessToken: "a", expiresAt: now + 3_600_000 }, now)).toBe(false);
  expect(agyTokenStale({ accessToken: "a", expiresAt: null }, now)).toBe(false);
});

const SUMMARY = {
  groups: [
    { displayName: "Gemini Models", description: "Gemini Flash, Gemini Pro", buckets: [
      { bucketId: "g-week", displayName: "Weekly Limit", window: "WEEKLY", remainingFraction: 0.9983, resetTime: "2026-10-22T10:00:00Z" },
      { bucketId: "g-5h", displayName: "Five Hour Limit", window: "FIVE_HOURS", remainingFraction: 0.9932, resetTime: "2026-10-15T15:00:00Z" },
    ] },
    { displayName: "Claude and GPT Models", buckets: [
      { bucketId: "c-week", displayName: "Weekly Limit", window: "WEEKLY", remainingFraction: 1 },
      { bucketId: "c-x", displayName: "Something else", window: "MONTHLY", remainingFraction: 0.5 },
      { bucketId: "c-off", displayName: "Five Hour Limit", window: "FIVE_HOURS", remainingFraction: 0.2, disabled: true },
    ] },
  ],
};

test("parseQuotaSummary: groups → weekly/five_hour windows, usage percentage, reset", () => {
  expect(parseQuotaSummary(SUMMARY)).toEqual([
    { id: "gemini-models", label: "Gemini Models", windows: [
      { window: "weekly", percentUsed: 0, resetsAt: Date.parse("2026-10-22T10:00:00Z") },
      { window: "five_hour", percentUsed: 1, resetsAt: Date.parse("2026-10-15T15:00:00Z") },
    ] },
    { id: "claude-and-gpt-models", label: "Claude and GPT Models", windows: [
      { window: "weekly", percentUsed: 0, resetsAt: null },
    ] },
  ]);
});

// Note: the brief had a single summary `toEqual` here with a conditional expression over all
// inputs at once — unreadable. Split into explicit expectations per input:
// `null`, `1`, `"x"`, `{ groups: "x" }` → null (not an object with a `groups` array);
// `{ groups: [{ buckets: "y" }] }` → `[]` (it is an array of groups, but the only group
// has broken `buckets`, so it is left out without windows).
test("parseQuotaSummary: nonsense → null, never an exception", () => {
  expect(parseQuotaSummary(null)).toBeNull();
  expect(parseQuotaSummary(1)).toBeNull();
  expect(parseQuotaSummary("x")).toBeNull();
  expect(parseQuotaSummary({ groups: "x" })).toBeNull();
  expect(parseQuotaSummary({ groups: [{ buckets: "y" }] })).toEqual([]);
});

// percentUsed is always clamped to 0..100 (a small extra fix, see the task) — even if
// Google once sent remainingFraction outside <0,1> (e.g. a rounding error
// over 1, or a negative value).
test("parseQuotaSummary: percentUsed is clamped to 0..100", () => {
  const edge = { groups: [{ displayName: "Edge", buckets: [
    { bucketId: "over", window: "WEEKLY", remainingFraction: -0.2 }, // 1-(-0.2)=1.2 → 120 → clamped to 100
    { bucketId: "under", window: "FIVE_HOURS", remainingFraction: 1.3 }, // 1-1.3=-0.3 → -30 → clamped to 0
  ] }] };
  const groups = parseQuotaSummary(edge)!;
  const windows = new Map(groups[0]!.windows.map((w) => [w.window, w.percentUsed]));
  expect(windows.get("weekly")).toBe(100);
  expect(windows.get("five_hour")).toBe(0);
});

// Verified live (Questions 7–11, section "Quota"): without this User-Agent (or with a different one,
// e.g. "jetski/1.3.5") retrieveUserQuotaSummary returns 403.
test("agyUserAgent: arch → amd64/arm64, otherwise passthrough", () => {
  expect(agyUserAgent("x64")).toBe("antigravity/1.3.5 linux/amd64");
  expect(agyUserAgent("arm64")).toBe("antigravity/1.3.5 linux/arm64");
  expect(agyUserAgent("ia32")).toBe("antigravity/1.3.5 linux/ia32");
});

test("fetchAgyQuota: calls only retrieveUserQuotaSummary on daily-cloudcode-pa, with the project, UA and bearer in the header; no loadCodeAssist", async () => {
  const seen: { url: string; body: string; auth: string | null; ua: string | null }[] = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    const headers = new Headers(init.headers);
    seen.push({ url, body: String(init.body), auth: headers.get("authorization"), ua: headers.get("user-agent") });
    return Response.json(SUMMARY);
  }) as typeof fetch;
  const r = await fetchAgyQuota({ accessToken: "ya29.SECRET", expiresAt: null }, "proj-1", fakeFetch, "antigravity/1.3.5 linux/amd64");
  expect(r.ok).toBe(true);
  expect(seen).toHaveLength(1);
  expect(seen[0]!.url).toBe("https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary");
  expect(JSON.parse(seen[0]!.body)).toEqual({ project: "proj-1" });
  expect(seen[0]!.auth).toBe("Bearer ya29.SECRET");
  expect(seen[0]!.ua).toBe("antigravity/1.3.5 linux/amd64");

  const failing = (async () => new Response("denied ya29.SECRET", { status: 401 })) as unknown as typeof fetch;
  const f = await fetchAgyQuota({ accessToken: "ya29.SECRET", expiresAt: null }, "proj-1", failing, "antigravity/1.3.5 linux/amd64");
  expect(f.ok).toBe(false);
  expect(JSON.stringify(f)).not.toContain("SECRET");
});
