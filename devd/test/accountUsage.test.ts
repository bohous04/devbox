import { expect, test } from "bun:test";
import { OAUTH_BETA, ORG_ID_HEADER, USAGE_URL, fetchUsage, parseUsage, toEpochMs } from "../src/accountUsage";

test("toEpochMs: ISO string, seconds, milliseconds, nonsense", () => {
  expect(toEpochMs("2026-07-28T10:00:00Z")).toBe(Date.parse("2026-07-28T10:00:00Z"));
  expect(toEpochMs(1_800_000_000)).toBe(1_800_000_000_000);      // seconds → ms
  expect(toEpochMs(1_800_000_000_000)).toBe(1_800_000_000_000);  // already ms
  expect(toEpochMs(null)).toBe(null);
  expect(toEpochMs("whenever")).toBe(null);
  expect(toEpochMs(undefined)).toBe(null);
});

// The real response shape from a live call on 2026-07-28: `group` next to `kind`,
// severity "normal", resets_at ISO with microseconds. At the same time proof that utilization
// and percent are THE SAME quantity on the same scale (3.0 vs 3).
test("parseUsage: real response — utilization and percent are the same (0–100)", () => {
  const u = parseUsage({
    five_hour: { utilization: 3.0, resets_at: "2026-07-28T18:00:00.458364+00:00" },
    limits: [
      { kind: "session", group: "session", percent: 3, severity: "normal",
        resets_at: "2026-07-28T18:00:00.458364+00:00", is_active: true },
    ],
  });
  expect(u.fiveHourPct).toBe(3);
  // microseconds are truncated to ms, not to NaN
  expect(u.fiveHourResetsAt).toBe(1_785_261_600_458);
  expect(u.limits[0].severity).toBe("normal");
  expect(u.limits[0].kind).toBe("session");
});

test("parseUsage: percentages from limits[] take precedence over utilization", () => {
  const u = parseUsage({
    five_hour: { utilization: 11, resets_at: "2026-07-28T12:00:00Z" },
    seven_day: { utilization: 22, resets_at: "2026-08-01T12:00:00Z" },
    limits: [
      { kind: "session", percent: 47.5, severity: "normal", resets_at: "2026-07-28T12:00:00Z", is_active: true },
      { kind: "weekly_all", percent: 63, severity: "warn", resets_at: "2026-08-01T12:00:00Z", is_active: true },
    ],
  });
  expect(u.fiveHourPct).toBe(47.5);
  expect(u.sevenDayPct).toBe(63);
  expect(u.fiveHourResetsAt).toBe(Date.parse("2026-07-28T12:00:00Z"));
  expect(u.sevenDayResetsAt).toBe(Date.parse("2026-08-01T12:00:00Z"));
});

test("parseUsage: without limits[] it falls back to utilization WITHOUT conversion (it is already a percentage)", () => {
  const u = parseUsage({
    five_hour: { utilization: 11, resets_at: 1_800_000_000 },
    seven_day: { utilization: 22, resets_at: 1_800_600_000 },
  });
  expect(u.fiveHourPct).toBe(11);
  expect(u.sevenDayPct).toBe(22);
  expect(u.fiveHourResetsAt).toBe(1_800_000_000_000);
  expect(u.limits).toEqual([]);
});

test("parseUsage: weekly_scoped carries the model name and goes into limits[]", () => {
  const u = parseUsage({
    limits: [
      { kind: "weekly_scoped", percent: 3, severity: "ok", resets_at: null, is_active: false,
        scope: { model: { display_name: "Fable" } } },
    ],
  });
  expect(u.limits.length).toBe(1);
  expect(u.limits[0]).toEqual({
    kind: "weekly_scoped", percent: 3, severity: "ok", resetsAt: null, modelName: "Fable", isActive: false,
  });
  // the scoped window is NEITHER 5h nor 7d — it must not overwrite them
  expect(u.fiveHourPct).toBe(null);
  expect(u.sevenDayPct).toBe(null);
});

test("parseUsage: an empty / broken response does not crash, returns all null", () => {
  const empty = { fiveHourPct: null, fiveHourResetsAt: null, sevenDayPct: null, sevenDayResetsAt: null, limits: [] };
  expect(parseUsage({})).toEqual(empty);
  expect(parseUsage(null)).toEqual(empty);
  expect(parseUsage("nonsense")).toEqual(empty);
  expect(parseUsage({ limits: "ne-pole" })).toEqual(empty);
  expect(parseUsage({ five_hour: { utilization: "lots" } }).fiveHourPct).toBe(null);
});

test("fetchUsage: sends Bearer and the beta header; a non-zero status is an error", async () => {
  const seen: { url: string; headers: Record<string, string> }[] = [];
  const ok = (async (url: string, init: RequestInit) => {
    seen.push({ url, headers: init.headers as Record<string, string> });
    return new Response(JSON.stringify({ limits: [{ kind: "session", percent: 5, is_active: true }] }), { status: 200 });
  }) as unknown as typeof fetch;
  const u = await fetchUsage("tok-123", ok);
  expect(u.fiveHourPct).toBe(5);
  expect(seen[0].url).toBe(USAGE_URL);
  expect(seen[0].headers.Authorization).toBe("Bearer tok-123");
  expect(seen[0].headers["anthropic-beta"]).toBe(OAUTH_BETA);

  const bad = (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch;
  await expect(fetchUsage("tok-123", bad)).rejects.toThrow("HTTP 401");
});

// The identity the token belongs to can be read for FREE from the header of every response —
// /api/oauth/profile would be an extra request and `/usage` is sensitive to the number of calls
// (returns 429). The detection of a swapped profile rests on this header.
test("fetchUsage: extracts the organization from the anthropic-organization-id header", async () => {
  const f = (async () => new Response(JSON.stringify({ limits: [{ kind: "session", percent: 5 }] }), {
    status: 200, headers: { [ORG_ID_HEADER]: "org-abc" },
  })) as unknown as typeof fetch;
  expect((await fetchUsage("tok", f)).orgId).toBe("org-abc");
});

// "I don't know" MUST NOT be confused with "a different organization" — otherwise a missing header would look
// like a swapped profile and devd would shout at a healthy account.
test("fetchUsage: a missing and an empty header give null, not an empty string", async () => {
  const mk = (headers: Record<string, string>) => (async () => new Response("{}", { status: 200, headers })) as unknown as typeof fetch;
  expect((await fetchUsage("tok", mk({}))).orgId).toBe(null);
  expect((await fetchUsage("tok", mk({ [ORG_ID_HEADER]: "" }))).orgId).toBe(null);
});
