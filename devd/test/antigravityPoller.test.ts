import { expect, test } from "bun:test";
import { openDb, getHarvestState } from "../src/db";
import { buildWeeklyUsage } from "../src/weeklyUsage";
import { pollAgy, type AgyHarvestState } from "../src/antigravityPoller";
import type { CodexPollerDeps } from "../src/codexPoller";

const NOW = 1_787_224_361_140;
const TOKEN_PATH = "/home/dev/.gemini/antigravity-cli/antigravity-oauth-token";
const PROJECT_PATH = "/home/dev/.gemini/antigravity-cli/cache/default_project_id.txt";

// The same fixture as antigravityUsageFetch.test.ts (Task 2) — two groups,
// each with a weekly window and (only Gemini) five_hour.
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

const tokenJson = (expiresAt: string | null) => JSON.stringify({
  access_token: "ya29.SECRET",
  ...(expiresAt ? { expiry: expiresAt } : {}),
});

// loadCodeAssist is not called (Questions 7–11: for this subscription type it does not return
// the project and is on a different host) — the only call is retrieveUserQuotaSummary.
const okFetch = (async () => Response.json(SUMMARY)) as unknown as typeof fetch;

// `run` routes by the last argv item (the file path in `cat <path>`,
// see readVolumeFile) — the token and the project live at different paths in the same volume.
function deps(over: Partial<CodexPollerDeps> = {}): CodexPollerDeps {
  return {
    db: openDb(":memory:"),
    run: async (cmd: string[]) => cmd.at(-1) === PROJECT_PATH
      ? { code: 0, stdout: "proj-1\n", stderr: "" }
      : { code: 0, stdout: tokenJson(null), stderr: "" },
    fetch: okFetch,
    now: () => NOW,
    ...over,
  };
}

test("pollAgy: valid token → two groups in weekly usage with weekly and five_hour windows", async () => {
  const d = deps();
  await pollAgy(d);
  const accounts = buildWeeklyUsage(d.db, 0, NOW, NOW).accounts.filter((a) => a.provider === "agy");
  const byId = new Map(accounts.map((a) => [a.accountId, a]));

  const gemini = byId.get("gemini-models")!;
  expect(gemini).toBeDefined();
  expect(gemini.accountLabel).toBe("Gemini Models");
  expect(gemini.state).toBe("ok");
  expect(new Map(gemini.latest.map((p) => [p.window, p.percentUsed]))).toEqual(new Map([["weekly", 0], ["five_hour", 1]]));
  expect(gemini.latest.find((p) => p.window === "weekly")!.resetsAt).toBe(Date.parse("2026-10-22T10:00:00Z"));
  expect(gemini.latest.find((p) => p.window === "five_hour")!.resetsAt).toBe(Date.parse("2026-10-15T15:00:00Z"));

  const claudeGpt = byId.get("claude-and-gpt-models")!;
  expect(claudeGpt).toBeDefined();
  expect(claudeGpt.accountLabel).toBe("Claude and GPT Models");
  expect(claudeGpt.latest).toEqual([{ window: "weekly", percentUsed: 0, resetsAt: null, sampledAt: NOW }]);

  const state = getHarvestState<AgyHarvestState>(d.db, "agy-quota")!;
  expect(state.state).toBe("ok");
  expect(state.groups.sort()).toEqual(["claude-and-gpt-models", "gemini-models"]);
});

test("pollAgy: missing token → signed-out, no fetch; next poll only after 1 h", async () => {
  let fetchCalls = 0;
  const fetchSpy = (async (...args: Parameters<typeof fetch>) => { fetchCalls++; return okFetch(...args); }) as unknown as typeof fetch;
  const run = async () => ({ code: 1, stdout: "", stderr: `cat: ${TOKEN_PATH}: No such file or directory` });
  const d = deps({ run, fetch: fetchSpy });

  await pollAgy(d);
  expect(getHarvestState<AgyHarvestState>(d.db, "agy-quota")!.state).toBe("signed-out");
  expect(fetchCalls).toBe(0);

  let runCalls = 0;
  const countedRun = async () => { runCalls++; return run(); };
  await pollAgy(deps({ db: d.db, run: countedRun, fetch: fetchSpy, now: () => NOW + 5 * 60_000 }));
  expect(runCalls).toBe(0); // backoff: within the hour it is not due yet

  await pollAgy(deps({ db: d.db, run: countedRun, fetch: fetchSpy, now: () => NOW + 61 * 60_000 }));
  expect(runCalls).toBe(1); // after an hour it is due again
});

test("pollAgy: expired token → stale-login, no fetch", async () => {
  let fetchCalls = 0;
  const fetchSpy = (async (...args: Parameters<typeof fetch>) => { fetchCalls++; return okFetch(...args); }) as unknown as typeof fetch;
  const d = deps({
    run: async () => ({ code: 0, stdout: tokenJson(new Date(NOW - 1000).toISOString()), stderr: "" }),
    fetch: fetchSpy,
  });
  await pollAgy(d);
  expect(getHarvestState<AgyHarvestState>(d.db, "agy-quota")!.state).toBe("stale-login");
  expect(fetchCalls).toBe(0);

  // stale-login is NOT the backoff for error/signed-out: it must stay due at the regular
  // cadence (agy refreshes the token itself in the session — this is not an incident).
  let runCalls = 0;
  const run2 = async () => { runCalls++; return { code: 0, stdout: tokenJson(new Date(NOW - 1000).toISOString()), stderr: "" }; };
  await pollAgy(deps({ db: d.db, run: run2, fetch: fetchSpy, now: () => NOW + 5 * 60_000 }));
  expect(runCalls).toBe(1);
});

test("pollAgy: HTTP error → error, weeklyUsageFailed for known groups, the token is not in the stored state", async () => {
  const d = deps();
  await pollAgy(d); // a healthy poll first, so harvest_state knows both group ids

  const failing = (async () => new Response("denied ya29.SECRET", { status: 401 })) as unknown as typeof fetch;
  await pollAgy(deps({ db: d.db, fetch: failing, now: () => NOW + 61 * 60_000 }));

  const to = NOW + 61 * 60_000;
  const accounts = buildWeeklyUsage(d.db, 0, to, to).accounts.filter((a) => a.provider === "agy");
  expect(accounts.find((a) => a.accountId === "gemini-models")!.state).toBe("error");
  expect(accounts.find((a) => a.accountId === "claude-and-gpt-models")!.state).toBe("error");

  const raw = getHarvestState<AgyHarvestState>(d.db, "agy-quota")!;
  expect(raw.state).toBe("error");
  expect(raw.error).toContain("401");
  expect(JSON.stringify(raw)).not.toContain("SECRET");
});

// Regression from fix round 1: `antigravity-home` is EVERYWHERE ELSE (index.ts extraMounts,
// agentAuth.ts authStatus/login/status) mounted as the whole /home/dev/.gemini.
// A mount on the token's parent directory (antigravity-cli) would be a DIFFERENT place than where
// agy actually writes — `cat` would always report "No such file" (signed-out forever) and
// docker would moreover create a foreign volume on the first poll with a mountpoint inside
// the image (root:root).
// The same mount reasoning applies to the second file read from the same volume —
// the project (default_project_id.txt), see pollAgy below.
test("pollAgy: mounts antigravity-home at /home/dev/.gemini for both the token and the project", async () => {
  const seenCmds: string[][] = [];
  const d = deps({
    run: async (cmd: string[]) => {
      seenCmds.push(cmd);
      return cmd.at(-1) === PROJECT_PATH
        ? { code: 0, stdout: "proj-1\n", stderr: "" }
        : { code: 0, stdout: tokenJson(null), stderr: "" };
    },
  });
  await pollAgy(d);
  expect(seenCmds).toHaveLength(2);
  for (const cmd of seenCmds) expect(cmd).toContain("antigravity-home:/home/dev/.gemini");
  expect(seenCmds.map((c) => c.at(-1)).sort()).toEqual([PROJECT_PATH, TOKEN_PATH].sort());
});

test("pollAgy: missing project (empty file) → error with a message, fetch is not called", async () => {
  let fetchCalls = 0;
  const fetchSpy = (async (...args: Parameters<typeof fetch>) => { fetchCalls++; return okFetch(...args); }) as unknown as typeof fetch;
  const run = async (cmd: string[]) => cmd.at(-1) === PROJECT_PATH
    ? { code: 0, stdout: "", stderr: "" }
    : { code: 0, stdout: tokenJson(null), stderr: "" };
  const d = deps({ run, fetch: fetchSpy });

  await pollAgy(d);
  expect(fetchCalls).toBe(0);
  const state = getHarvestState<AgyHarvestState>(d.db, "agy-quota")!;
  expect(state.state).toBe("error");
  expect(state.error).toBe("Antigravity project missing (run a session once)");
});

test("pollAgy: the readProject hook (like readAuth) bypasses readVolumeFile — deterministic without a run mock", async () => {
  const d = deps({
    run: async () => { throw new Error("run must not be called when readProject is given"); },
    readAuth: async () => ({ raw: tokenJson(null), dockerError: null }),
    readProject: async () => ({ raw: "proj-from-hook", dockerError: null }),
  });
  const seen: string[] = [];
  const fetchSpy = (async (_url: unknown, init: RequestInit) => { seen.push(JSON.parse(String(init.body)).project); return Response.json(SUMMARY); }) as unknown as typeof fetch;
  await pollAgy({ ...d, fetch: fetchSpy });
  expect(seen).toEqual(["proj-from-hook"]);
  expect(getHarvestState<AgyHarvestState>(d.db, "agy-quota")!.state).toBe("ok");
});

// Regression from fix round 1: a group that the last successful poll knew (gemini-models),
// but that the new response no longer returns (Google removed/merged it), must not silently stay
// hanging in the history as "ok" with the old last reading forever.
test("pollAgy: a group missing from the new response gets weeklyUsageFailed", async () => {
  const d = deps();
  await pollAgy(d); // a healthy poll with two groups

  const onlyClaudeGpt = { groups: [SUMMARY.groups[1]] };
  const fetchOneGroup = (async (url: unknown) => String(url).endsWith(":loadCodeAssist")
    ? Response.json({ cloudaicompanionProject: "proj-1" })
    : Response.json(onlyClaudeGpt)
  ) as unknown as typeof fetch;
  await pollAgy(deps({ db: d.db, fetch: fetchOneGroup, now: () => NOW + 1000 }));

  const accounts = buildWeeklyUsage(d.db, 0, NOW + 1000, NOW + 1000).accounts.filter((a) => a.provider === "agy");
  expect(accounts.find((a) => a.accountId === "gemini-models")!.state).toBe("error");
  expect(accounts.find((a) => a.accountId === "claude-and-gpt-models")!.state).toBe("ok");

  const state = getHarvestState<AgyHarvestState>(d.db, "agy-quota")!;
  expect(state.state).toBe("ok");
  expect(state.groups).toEqual(["claude-and-gpt-models"]);
});

// Regression from fix round 1: `ok: true` with an empty `groups` (e.g. Google renames
// the window strings and parseQuotaSummary recognizes no group) is NOT a success without
// data — it would silently write the state "ok" and wipe the existing history from the dashboard.
test("pollAgy: empty groups in the response → error \"empty quota\", the existing groups stay available", async () => {
  const d = deps();
  await pollAgy(d); // a healthy poll with two groups

  const emptyFetch = (async (url: unknown) => String(url).endsWith(":loadCodeAssist")
    ? Response.json({ cloudaicompanionProject: "proj-1" })
    : Response.json({ groups: [] })
  ) as unknown as typeof fetch;
  await pollAgy(deps({ db: d.db, fetch: emptyFetch, now: () => NOW + 1000 }));

  const accounts = buildWeeklyUsage(d.db, 0, NOW + 1000, NOW + 1000).accounts.filter((a) => a.provider === "agy");
  expect(accounts.find((a) => a.accountId === "gemini-models")!.state).toBe("error");
  expect(accounts.find((a) => a.accountId === "claude-and-gpt-models")!.state).toBe("error");

  const state = getHarvestState<AgyHarvestState>(d.db, "agy-quota")!;
  expect(state.state).toBe("error");
  expect(state.error).toBe("empty quota");
  expect(state.groups.sort()).toEqual(["claude-and-gpt-models", "gemini-models"]);
});
