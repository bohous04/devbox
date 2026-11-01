import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, insertSession, insertNotifyLog, deleteSession, getHarvestState, setHarvestState, type SessionRow } from "../src/db";
import type { CodexPollerDeps } from "../src/codexPoller";
import { harvestCodex, harvestCodexAccounts, parseCodexScan, totalsDelta, CODEX_SCAN_PY, CODEX_STATE_VERSION, type CodexHarvesterDeps } from "../src/codexHarvester";
import { initCodexAccounts } from "../src/codexAccountsDb";

const TOKEN_LINE = JSON.stringify({ timestamp: "2026-08-22T21:32:17.364Z", type: "event_msg", payload: {
  type: "token_count", info: { total_token_usage: { input_tokens: 18_825, cached_input_tokens: 11_008,
  cache_write_input_tokens: 5, output_tokens: 139, reasoning_output_tokens: 21, total_tokens: 18_964 } } } });
const CTX_LINE = JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.6-sol" } });

test("parses the scan output: id from the path, cumulatives, model", () => {
  const out = `== /home/dev/.codex/sessions/2026/08/22/rollout-2026-08-22T23-31-35-01a02b62-df37-7982-8670-c2f2460b3c26.jsonl\n${CTX_LINE}\n${TOKEN_LINE}\n`;
  const snaps = parseCodexScan(out);
  expect(snaps).toHaveLength(1);
  expect(snaps[0].rolloutId).toBe("01a02b62-df37-7982-8670-c2f2460b3c26");
  expect(snaps[0].totals).toEqual({ input: 7_812, cacheRead: 11_008, cacheWrite: 5, output: 139 });
  expect(snaps[0].model).toBe("gpt-5.6-sol");
});

test("a file without token_count is skipped", () => {
  expect(parseCodexScan("== /x/rollout-2026-08-22T23-31-35-01a02b62-df37-7982-8670-c2f2460b3c26.jsonl\n\n")).toHaveLength(0);
});

test("totalsDelta: difference, nothing new, reset", () => {
  const a = { input: 10, cacheRead: 20, cacheWrite: 0, output: 5 };
  const b = { input: 15, cacheRead: 30, cacheWrite: 0, output: 6 };
  expect(totalsDelta(a, b)).toEqual({ input: 5, cacheRead: 10, cacheWrite: 0, output: 1 });
  expect(totalsDelta(b, b)).toBeNull();
  expect(totalsDelta(undefined, a)).toEqual(a);
  expect(totalsDelta(b, a)).toEqual(a); // negative delta = a new file from zero → the whole cur
});

// ---- harvestCodex (integration: docker scan → delta → metrics → state) ----

// NOW = 2026-08-20T11:12:41.140Z. The default rollout timestamp (2026-08-22) is
// deliberately AFTER NOW, so the existing tests (first run = firstRunAt at NOW) keep
// getting the "post-deploy" behaviour unchanged.
const NOW = 1_787_224_361_140;
const ROLLOUT_ID = "01a02b62-df37-7982-8670-c2f2460b3c26";
const rolloutPath = (id = ROLLOUT_ID, ts = "2026-08-22T23-31-35") =>
  `/home/dev/.codex/sessions/2026/08/22/rollout-${ts}-${id}.jsonl`;

function scanOut(totals: { input: number; cachedInput: number; cacheWrite: number; output: number }, model = "gpt-5.6-sol", id = ROLLOUT_ID, ts?: string): string {
  const tokenLine = JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: {
    input_tokens: totals.input + totals.cachedInput + totals.cacheWrite, cached_input_tokens: totals.cachedInput,
    cache_write_input_tokens: totals.cacheWrite, output_tokens: totals.output } } } });
  const ctxLine = JSON.stringify({ type: "turn_context", payload: { model } });
  return `== ${rolloutPath(id, ts)}\n${ctxLine}\n${tokenLine}\n`;
}

function deps(over: Partial<CodexPollerDeps> = {}): CodexPollerDeps {
  return {
    db: openDb(":memory:"),
    run: async () => ({ code: 0, stdout: "", stderr: "" }),
    fetch: (async () => new Response("{}")) as unknown as typeof fetch,
    now: () => NOW,
    ...over,
  };
}

const session: SessionRow = {
  id: "dev-p-r", folder: "/repos", project: "p", repo: "r", container: "c",
  port_base: 10_000, status: "running", solo: 0, created_at: NOW, last_active_at: NOW, important: 0,
};

test("harvestCodex: an empty scan stores no metrics, only advances sinceSec", async () => {
  const d = deps();
  await harvestCodex(d);
  const rows = d.db.query("SELECT COUNT(*) n FROM metrics").get() as { n: number };
  expect(rows.n).toBe(0);
  expect(getHarvestState<{ sinceSec: number }>(d.db, "codex")!.sinceSec).toBe(Math.floor(NOW / 1000));
});

test("harvestCodex: a docker error leaves the state untouched", async () => {
  const d = deps({ run: async () => ({ code: 1, stdout: "", stderr: "docker daemon is not running" }) });
  await harvestCodex(d);
  expect(getHarvestState(d.db, "codex")).toBeNull();
});

test("harvestCodex: a new rollout — attribution via notify_log, writes the WHOLE cumulatives", async () => {
  const d = deps({
    run: async () => ({ code: 0, stdout: scanOut({ input: 1_000, cachedInput: 500, cacheWrite: 0, output: 200 }), stderr: "" }),
  });
  insertSession(d.db, session);
  insertNotifyLog(d.db, {
    ts: NOW, session_id: session.id, event: "hook", decision: "none", reason: null,
    inflight: 0, teammates: 0, agent_session_id: ROLLOUT_ID, detail: null,
  });

  await harvestCodex(d);

  const tok = d.db.query("SELECT value, session_id, attrs FROM metrics WHERE name='claude_code.token.usage'").all() as
    { value: number; session_id: string | null; attrs: string }[];
  expect(tok.every((r) => r.session_id === "dev-p-r")).toBe(true);
  const byType = Object.fromEntries(tok.map((r) => [JSON.parse(r.attrs).type, r.value]));
  expect(byType.input).toBe(1_000);
  expect(byType.cacheRead).toBe(500);
  expect(byType.output).toBe(200);
  expect(tok.every((r) => JSON.parse(r.attrs).model === "gpt-5.6-sol")).toBe(true);
  // gpt-5.6-sol is in the price list → cost too
  const cost = d.db.query("SELECT COUNT(*) n FROM metrics WHERE name='claude_code.cost.usage'").get() as { n: number };
  expect(cost.n).toBeGreaterThan(0);

  const st = getHarvestState<{ files: Record<string, { session: string | null }> }>(d.db, "codex")!;
  expect(st.files[ROLLOUT_ID].session).toBe("dev-p-r");
});

// History backfill: NO — collected from deployment (spec, binding decision "History
// backfill"). A rollout that existed BEFORE the first run after deployment and appears
// in the state for the first time would otherwise write its whole cumulative as one delta.
test("harvestCodex: a rollout older than firstRunAt (existed BEFORE deployment) — baseline only, no rows", async () => {
  const OLD_TS = "2026-08-18T10-00-00"; // before NOW (2026-08-20T11:12:41Z) = "before deployment"
  const d = deps({
    run: async () => ({
      code: 0,
      stdout: scanOut({ input: 1_000, cachedInput: 500, cacheWrite: 0, output: 200 }, "gpt-5.6-sol", ROLLOUT_ID, OLD_TS),
      stderr: "",
    }),
  });
  insertSession(d.db, session);
  insertNotifyLog(d.db, {
    ts: NOW, session_id: session.id, event: "hook", decision: "none", reason: null,
    inflight: 0, teammates: 0, agent_session_id: ROLLOUT_ID, detail: null,
  });

  await harvestCodex(d); // the existing state is null → this run sets firstRunAt = NOW

  expect((d.db.query("SELECT COUNT(*) n FROM metrics").get() as { n: number }).n).toBe(0);
  const st = getHarvestState<{ files: Record<string, { totals: unknown; session: string | null }> }>(d.db, "codex")!;
  // the baseline is stored (attribution and totals), it just produces no row
  expect(st.files[ROLLOUT_ID].session).toBe("dev-p-r");
  expect(st.files[ROLLOUT_ID].totals).toEqual({ input: 1_000, cacheRead: 500, cacheWrite: 0, output: 200 });
});

test("harvestCodex: a rollout created ONLY after deployment (even on its first appearance in the state) — normal behaviour, writes the whole cumulatives", async () => {
  const NEW_TS = "2026-08-21T09-00-00"; // after NOW (2026-08-20T11:12:41Z) = "after deployment"
  const d = deps({
    run: async () => ({
      code: 0,
      stdout: scanOut({ input: 1_000, cachedInput: 500, cacheWrite: 0, output: 200 }, "gpt-5.6-sol", ROLLOUT_ID, NEW_TS),
      stderr: "",
    }),
  });
  insertSession(d.db, session);
  insertNotifyLog(d.db, {
    ts: NOW, session_id: session.id, event: "hook", decision: "none", reason: null,
    inflight: 0, teammates: 0, agent_session_id: ROLLOUT_ID, detail: null,
  });

  await harvestCodex(d);

  const tok = d.db.query("SELECT value FROM metrics WHERE name='claude_code.token.usage' AND attrs LIKE '%\"input\"%'").all() as { value: number }[];
  expect(tok.reduce((s, r) => s + r.value, 0)).toBe(1_000); // the whole cumulative, not 0
});

test("harvestCodex: an unattributed rollout (notify_log without an entry) — a metric without a session, the delta keeps counting afterwards", async () => {
  const first = deps({
    run: async () => ({ code: 0, stdout: scanOut({ input: 1_000, cachedInput: 0, cacheWrite: 0, output: 100 }), stderr: "" }),
  });
  await harvestCodex(first);
  const rows1 = first.db.query("SELECT session_id FROM metrics WHERE name='claude_code.token.usage'").all() as { session_id: string | null }[];
  expect(rows1.length).toBeGreaterThan(0);
  expect(rows1.every((r) => r.session_id === null)).toBe(true);

  // second run: 300 input is added, still without attribution (notify_log still missing)
  const second = deps({
    db: first.db,
    now: () => NOW + 60_000,
    run: async () => ({ code: 0, stdout: scanOut({ input: 1_300, cachedInput: 0, cacheWrite: 0, output: 100 }), stderr: "" }),
  });
  await harvestCodex(second);
  const inputRows = second.db.query(
    "SELECT value FROM metrics WHERE name='claude_code.token.usage' AND attrs LIKE '%\"input\"%'",
  ).all() as { value: number }[];
  expect(inputRows.reduce((s, r) => s + r.value, 0)).toBe(1_300); // 1000 (1st run) + 300 (delta of the 2nd run)
});

test("harvestCodex: totals unchanged (nothing new) adds no metric", async () => {
  const out = scanOut({ input: 1_000, cachedInput: 0, cacheWrite: 0, output: 100 });
  const first = deps({ run: async () => ({ code: 0, stdout: out, stderr: "" }) });
  await harvestCodex(first);
  const n1 = (first.db.query("SELECT COUNT(*) n FROM metrics").get() as { n: number }).n;

  const second = deps({ db: first.db, now: () => NOW + 60_000, run: async () => ({ code: 0, stdout: out, stderr: "" }) });
  await harvestCodex(second);
  const n2 = (second.db.query("SELECT COUNT(*) n FROM metrics").get() as { n: number }).n;
  expect(n2).toBe(n1); // the same cumulatives → totalsDelta returns null, nothing is added
});

test("harvestCodex: retains more than 1000 baselines so resuming an old session never recounts history", async () => {
  const MAX_FILES = 1000; // former cap
  const NEW_ID = "ffffffff-ffff-ffff-ffff-ffffffffffff";
  let out = scanOut({ input: 50, cachedInput: 0, cacheWrite: 0, output: 5 }, "gpt-5.6-sol", NEW_ID);
  const d = deps({
    run: async () => ({
      code: 0,
      stdout: out,
      stderr: "",
    }),
  });
  // Fill the state with exactly MAX_FILES existing entries, oldest = lowest updatedAt.
  const files: Record<string, { totals: { input: number; cacheRead: number; cacheWrite: number; output: number }; model: string | null; session: string | null; updatedAt: number }> = {};
  for (let i = 0; i < MAX_FILES; i++) {
    files[i === 0 ? ROLLOUT_ID : `seed-${i}`] = { totals: { input: 1, cacheRead: 0, cacheWrite: 0, output: 0 }, model: null, session: null, updatedAt: NOW - (MAX_FILES - i) * 1_000 };
  }
  setHarvestState(d.db, "codex", { sinceSec: Math.floor(NOW / 1000) - 60, files });

  await harvestCodex(d);

  const st = getHarvestState<{ files: Record<string, { updatedAt: number }> }>(d.db, "codex")!;
  expect(Object.keys(st.files).length).toBe(MAX_FILES + 1);
  expect(st.files[ROLLOUT_ID]).toBeDefined();
  expect(st.files["seed-1"]).toBeDefined();     // the second oldest survived
  expect(st.files[NEW_ID]).toBeDefined();       // the newly added one (updatedAt = NOW, newest) survived
  out = scanOut({ input: 2, cachedInput: 0, cacheWrite: 0, output: 0 });
  await harvestCodex(d);
  expect(tokenSum(d)).toBe(56); // new rollout 55 + old rollout delta 1
});

// The session ended INSIDE the last window (deleteSession) between two harvest cycles —
// project/repo are cached in the state on the FIRST successful attribution, when getSession still
// sees the session, so a later delta keeps carrying them even after the session is deleted.
test("harvestCodex: delta after the session is deleted — rows carry session/project/repo from the state cache", async () => {
  const first = deps({
    run: async () => ({ code: 0, stdout: scanOut({ input: 1_000, cachedInput: 0, cacheWrite: 0, output: 100 }), stderr: "" }),
  });
  insertSession(first.db, session);
  insertNotifyLog(first.db, {
    ts: NOW, session_id: session.id, event: "hook", decision: "none", reason: null,
    inflight: 0, teammates: 0, agent_session_id: ROLLOUT_ID, detail: null,
  });
  await harvestCodex(first);

  deleteSession(first.db, session.id); // the session ended between cycles

  const second = deps({
    db: first.db,
    now: () => NOW + 60_000,
    run: async () => ({ code: 0, stdout: scanOut({ input: 1_300, cachedInput: 0, cacheWrite: 0, output: 100 }), stderr: "" }),
  });
  await harvestCodex(second);

  const tok = second.db.query(
    "SELECT session_id, attrs FROM metrics WHERE name='claude_code.token.usage' AND attrs LIKE '%\"input\"%' ORDER BY ts",
  ).all() as { session_id: string | null; attrs: string }[];
  const last = tok[tok.length - 1]; // the delta written by the SECOND (post-deletion) run
  expect(last.session_id).toBe("dev-p-r");
  const attrs = JSON.parse(last.attrs);
  expect(attrs.project).toBe("p");
  expect(attrs.repo).toBe("r");
});


function context(model: string) { return JSON.stringify({ type: "turn_context", payload: { model } }); }
function checkpoint(input: number, output: number, promptTokens: number, cached = 0) {
  return JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: {
    total_token_usage: { input_tokens: input + cached, cached_input_tokens: cached, output_tokens: output },
    last_token_usage: { input_tokens: promptTokens, cached_input_tokens: cached },
  } } });
}

async function scanFixture(root: string, since: number, refresh: string[] = []) {
  const process = Bun.spawn(["python3", "-c", CODEX_SCAN_PY, root, String(since), JSON.stringify(refresh)], {
    stdout: "pipe", stderr: "pipe",
  });
  const out = await new Response(process.stdout).text();
  expect(await process.exited).toBe(0);
  expect(await new Response(process.stderr).text()).toBe("");
  return out;
}

test("metadata scanner ignores prompt lookalikes and final info:null, preserving ordered real context", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-scan-"));
  try {
    mkdirSync(join(root, "sessions"));
    const path = join(root, "sessions", rolloutPath().split("/").at(-1)!);
    writeFileSync(path, [
      context("gpt-6-astra"), checkpoint(100, 10, 150, 50),
      JSON.stringify({ type: "response_item", payload: { type: "message", content: [{ text: 'SECRET prompt mentions "turn_context" and "model":"fake-model"' }] } }),
      context("gpt-5.6-sol"), checkpoint(400, 30, 300_000, 60),
      JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: null } }),
      '{"type":"event_msg","payload":',
    ].join("\n"));
    const out = await scanFixture(root, 0);
    expect(out).not.toContain("SECRET");
    expect(out).not.toContain("fake-model");
    const [snap] = parseCodexScan(out);
    expect(snap.model).toBe("gpt-5.6-sol");
    expect(snap.checkpoints.map((p) => [p.model, p.promptTokens])).toEqual([
      ["gpt-6-astra", 150], ["gpt-5.6-sol", 300_000],
    ]);
    expect(snap.totals).toEqual({ input: 400, cacheRead: 60, cacheWrite: 0, output: 30 });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("legacy context envelope remains readable while arbitrary nested prompt data is ignored", () => {
  const legacy = JSON.stringify({ type: "response_item", payload: { type: "turn_context", payload: { model: "gpt-6-astra" } } });
  const [snap] = parseCodexScan(`== ${rolloutPath()}\n${legacy}\n${TOKEN_LINE}\n`);
  expect(snap.model).toBe("gpt-6-astra");
  expect(snap.checkpoints[0].model).toBe("gpt-6-astra");
});

test("harvestCodex attributes ordered deltas to each model and does not recount prior checkpoints", async () => {
  let out = `== ${rolloutPath()}\n${context("gpt-6-astra")}\n${checkpoint(100, 10, 150, 50)}\n${context("gpt-5.6-sol")}\n${checkpoint(400, 30, 300_000, 60)}\n`;
  const d = deps({ run: async () => ({ code: 0, stdout: out, stderr: "" }) });
  await harvestCodex(d);
  out += `${context("gpt-6-astra")}\n${checkpoint(450, 35, 100, 70)}\n`;
  await harvestCodex(d);
  await harvestCodex(d);
  const rows = d.db.query("SELECT value, attrs FROM metrics WHERE name='claude_code.token.usage' ORDER BY id").all() as { value: number; attrs: string }[];
  const inputs = rows.filter((r) => JSON.parse(r.attrs).type === "input");
  expect(inputs.map((r) => [JSON.parse(r.attrs).model, r.value])).toEqual([
    ["gpt-6-astra", 100], ["gpt-5.6-sol", 300], ["gpt-6-astra", 50],
  ]);
  expect(rows.every((r) => JSON.parse(r.attrs)["devbox.agent"] === "codex")).toBe(true);
  expect(rows.every((r) => JSON.parse(r.attrs)["devbox.usage.source_id"] === ROLLOUT_ID)).toBe(true);
  const solCost = d.db.query("SELECT SUM(value) total FROM metrics WHERE name='claude_code.cost.usage' AND a_model='gpt-5.6-sol'").get() as { total: number };
  // The request has a 300k prompt, including cached tokens, even though this
  // poll only added 300 ordinary input tokens. Use that request's long tier.
  expect(solCost.total).toBeCloseTo((300 * 8 + 10 * 0.8 + 20 * 30) / 1_000_000, 10);
});

test("harvestCodex refreshes inactive null models once without recounting historical totals", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-migration-"));
  try {
    mkdirSync(join(root, "sessions"));
    const path = join(root, "sessions", rolloutPath().split("/").at(-1)!);
    const d = deps();
    setHarvestState(d.db, "codex", {
      sinceSec: Math.floor(NOW / 1000), firstRunAt: Math.floor(NOW / 1000),
      files: { [ROLLOUT_ID]: { totals: { input: 100, cacheRead: 0, cacheWrite: 0, output: 10 }, model: null, session: null, updatedAt: 1 } },
    });
    let scans = 0;
    d.run = async (args) => {
      const script = args.at(-1)!;
      const command = script.split("\n")[0];
      expect(command.includes(ROLLOUT_ID)).toBe(scans < 2);
      const out = await scanFixture(root, Math.floor(NOW / 1000) - 120, scans++ < 2 ? [ROLLOUT_ID] : []);
      return { code: 0, stdout: out, stderr: "" };
    };
    await harvestCodex(d); // absent file: global migration succeeds, per-file retry remains pending
    expect(getHarvestState<{ files: Record<string, { model: string | null }> }>(d.db, "codex")!.files[ROLLOUT_ID].model).toBeNull();
    writeFileSync(path, `${context("gpt-6-astra")}\n${checkpoint(100, 10, 100)}\n`);
    utimesSync(path, 1, 1);
    await harvestCodex(d); // retry finds the restored inactive file
    await harvestCodex(d); // successful resolution is not rescanned again
    const state = getHarvestState<{ schemaVersion: number; files: Record<string, { model: string }> }>(d.db, "codex")!;
    expect(state.schemaVersion).toBe(CODEX_STATE_VERSION);
    expect(state.files[ROLLOUT_ID].model).toBe("gpt-6-astra");
    expect((d.db.query("SELECT COUNT(*) n FROM metrics").get() as { n: number }).n).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("harvestCodex commits metric rows and cumulative state atomically", async () => {
  const d = deps({ run: async () => ({ code: 0, stdout: scanOut({ input: 100, cachedInput: 0, cacheWrite: 0, output: 10 }), stderr: "" }) });
  d.db.exec("CREATE TRIGGER fail_codex_state BEFORE INSERT ON harvest_state BEGIN SELECT RAISE(ABORT, 'state write failed'); END");
  await expect(harvestCodex(d)).rejects.toThrow("state write failed");
  expect((d.db.query("SELECT COUNT(*) n FROM metrics").get() as { n: number }).n).toBe(0);
  expect(getHarvestState(d.db, "codex")).toBeNull();
  d.db.exec("DROP TRIGGER fail_codex_state");
  await harvestCodex(d);
  const rows = d.db.query("SELECT value FROM metrics WHERE name='claude_code.token.usage' AND attrs LIKE '%\"input\"%'").all() as { value: number }[];
  expect(rows.reduce((sum, row) => sum + row.value, 0)).toBe(100);
});


test("scanner read failure discards partial metadata instead of rolling the baseline back", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-read-error-"));
  try {
    mkdirSync(join(root, "sessions"));
    const path = join(root, "sessions", rolloutPath().split("/").at(-1)!);
    // Decode failure can arrive after an otherwise valid early usage checkpoint.
    writeFileSync(path, Buffer.concat([
      Buffer.from(`${context("gpt-6-astra")}\n${checkpoint(40, 4, 40)}\n` + " ".repeat(20_000)),
      Buffer.from([0xff]),
    ]));
    const out = await scanFixture(root, 0);
    expect(out).toBe("");
    const d = deps({ run: async () => ({ code: 0, stdout: out, stderr: "" }) });
    const totals = { input: 100, cacheRead: 0, cacheWrite: 0, output: 10 };
    setHarvestState(d.db, "codex", { sinceSec: 0, firstRunAt: 0, files: {
      [ROLLOUT_ID]: { totals, model: null, session: null, updatedAt: 1 },
    } });
    await harvestCodex(d);
    const file = getHarvestState<{ files: Record<string, { totals: unknown; modelRefreshVersion?: number }> }>(d.db, "codex")!.files[ROLLOUT_ID];
    expect(file.totals).toEqual(totals);
    expect(file.modelRefreshVersion).toBeUndefined();
    expect((d.db.query("SELECT COUNT(*) n FROM metrics").get() as { n: number }).n).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("malformed cumulative counters cannot reset the baseline and recount valid usage", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-invalid-usage-"));
  try {
    mkdirSync(join(root, "sessions"));
    const path = join(root, "sessions", rolloutPath().split("/").at(-1)!);
    const valid = checkpoint(100, 10, 150, 50);
    const prefix = `${context("gpt-6-astra")}\n${valid}\n`;
    writeFileSync(path, prefix);
    let out = await scanFixture(root, 0);
    const d = deps({ run: async () => ({ code: 0, stdout: out, stderr: "" }) });
    await harvestCodex(d);
    const rowCount = () => (d.db.query("SELECT COUNT(*) n FROM metrics").get() as { n: number }).n;
    const before = rowCount();
    const expected = { input: 100, cacheRead: 50, cacheWrite: 0, output: 10 };
    for (const usage of [
      {}, { input_tokens: 150 }, { output_tokens: 10 },
      { input_tokens: -1, output_tokens: 10 }, { input_tokens: 150, output_tokens: null },
      { input_tokens: 150, output_tokens: 10, cached_input_tokens: "invalid" },
      { input_tokens: 150, output_tokens: 10, cached_input_tokens: -1 },
      { input_tokens: 150, output_tokens: 10, cache_write_input_tokens: null },
      { input_tokens: 150, output_tokens: 10, cached_input_tokens: 151 },
      { input_tokens: 150, output_tokens: 10, cached_input_tokens: 100, cache_write_input_tokens: 51 },
    ]) {
      const malformed = JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: usage } } });
      // Exercise both the direct parser and actual Python metadata filtering:
      // invalid optional fields must remain invalid, not disappear into zero.
      expect(parseCodexScan(`== ${rolloutPath()}\n${prefix}${malformed}\n`)[0].totals).toEqual(expected);
      writeFileSync(path, `${prefix}${malformed}\n`);
      out = await scanFixture(root, 0);
      await harvestCodex(d);
      expect(getHarvestState<{ files: Record<string, { totals: unknown }> }>(d.db, "codex")!.files[ROLLOUT_ID].totals).toEqual(expected);
      writeFileSync(path, `${prefix}${malformed}\n${valid}\n`);
      out = await scanFixture(root, 0);
      await harvestCodex(d);
      expect(rowCount()).toBe(before);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function timedCheckpoint(input: number, output: number, ts: number) {
  return JSON.stringify({ ...JSON.parse(checkpoint(input, output, input)), timestamp: new Date(ts).toISOString() });
}
function addAccount(d: CodexHarvesterDeps, id: string, addedAt: number, disabled = 0) {
  initCodexAccounts(d.db);
  d.db.query("INSERT INTO codex_accounts(id,label,status,added_at,disabled) VALUES (?,?,'ready',?,?)").run(id, id, addedAt, disabled);
}
const tokenSum = (d: CodexHarvesterDeps) => (d.db.query("SELECT COALESCE(SUM(value),0) n FROM metrics WHERE name='claude_code.token.usage'").get() as { n: number }).n;

test("all profiles: recover previously omitted disabled account with event dates and never replay it", async () => {
  const day = Date.parse("2026-09-11T00:00:00+02:00");
  const acctId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const oldId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
  const scans: Array<[string, number]> = [];
  const oldScan = `== ${rolloutPath(oldId, "2026-09-09T23-00-00")}\n${CTX_LINE}\n${timedCheckpoint(1000, 100, day - 60000)}\n`;
  let addedScan = `== ${rolloutPath(acctId, "2026-09-10T10-00-00")}\n${CTX_LINE}\n${timedCheckpoint(50, 5, day - 120000)}\n${timedCheckpoint(100, 10, day + 60000)}\n`;
  const d: CodexHarvesterDeps = { ...deps({ now: () => day + 3600000 }), scan: async (volume, since) => {
    scans.push([volume, since]);
    return volume === "codex-home" ? oldScan : addedScan;
  } };
  addAccount(d, "second", day - 3600000, 1);
  setHarvestState(d.db, "codex", { schemaVersion: CODEX_STATE_VERSION, sinceSec: day / 1000, firstRunAt: 0, files: {
    [oldId]: { totals: { input: 1000, cacheRead: 0, cacheWrite: 0, output: 100 }, model: "gpt-5.6-sol", session: null, updatedAt: day },
  } });
  await harvestCodexAccounts(d);
  expect(scans.map(([volume]) => volume)).toEqual(["codex-home", "codex-acct-second"]);
  expect(scans[1][1]).toBe(0);
  expect(tokenSum(d)).toBe(110);
  const dated = d.db.query("SELECT ts, SUM(value) n FROM metrics WHERE name='claude_code.token.usage' GROUP BY ts ORDER BY ts").all();
  expect(dated).toEqual([{ ts: day - 120000, n: 55 }, { ts: day + 60000, n: 55 }]);
  await harvestCodexAccounts(d);
  expect(tokenSum(d)).toBe(110);
  addedScan += `${timedCheckpoint(200, 20, day + 120000)}\n`;
  await harvestCodexAccounts(d);
  expect(tokenSum(d)).toBe(220);
});

test("profile discovery uses only registered existing volumes and mounts histories read-only", async () => {
  const commands: string[][] = [];
  const d = deps({ run: async (cmd) => {
    commands.push(cmd);
    return { code: 0, stdout: cmd[0] === "volume" ? "codex-home\ncodex-acct-second\ncodex-acct-unregistered\n" : "", stderr: "" };
  } });
  addAccount(d, "second", NOW - 1);
  addAccount(d, "missing", NOW - 1);
  addAccount(d, "../invalid", NOW - 1);
  await harvestCodexAccounts(d);
  expect(commands.filter(cmd => cmd[0] === "run").map(cmd => cmd[cmd.indexOf("-v") + 1])).toEqual([
    "codex-home:/home/dev/.codex:ro,nocopy", "codex-acct-second:/home/dev/.codex:ro,nocopy",
  ]);
});

test("profile scan failure does not advance its cursor; a later scan recovers all missed events", async () => {
  let failing = true;
  const d: CodexHarvesterDeps = { ...deps(), scan: async volume => volume === "codex-home" ? "" : failing ? null
    : `== ${rolloutPath()}\n${CTX_LINE}\n${timedCheckpoint(100, 10, NOW - 10)}\n` };
  addAccount(d, "second", NOW - 1000);
  await harvestCodexAccounts(d);
  expect(getHarvestState<{ sources?: Record<string, unknown> }>(d.db, "codex")!.sources?.second).toBeUndefined();
  failing = false;
  await harvestCodexAccounts(d);
  expect(tokenSum(d)).toBe(110);
});

test("same rollout copied across profiles counts once even when one copy lags behind", async () => {
  const prefix = `== ${rolloutPath()}\n${CTX_LINE}\n${timedCheckpoint(100, 10, NOW)}\n`;
  let primary = prefix;
  let secondary = prefix;
  const d: CodexHarvesterDeps = { ...deps(), scan: async volume => volume === "codex-home" ? primary : secondary };
  addAccount(d, "second", NOW - 1000);
  await harvestCodexAccounts(d);
  expect(tokenSum(d)).toBe(110);
  primary += `${timedCheckpoint(200, 20, NOW + 1000)}\n`;
  await harvestCodexAccounts(d);
  expect(tokenSum(d)).toBe(220);
  secondary = primary;
  await harvestCodexAccounts(d);
  expect(tokenSum(d)).toBe(220);
});

test("checkpoint cursor records reset usage even when the final cumulative total equals the old total", async () => {
  let out = `== ${rolloutPath()}\n${CTX_LINE}\n${timedCheckpoint(100, 10, NOW)}\n`;
  const d: CodexHarvesterDeps = { ...deps(), scan: async () => out };
  await harvestCodex(d);
  expect(tokenSum(d)).toBe(110);
  out += `${timedCheckpoint(25, 2, NOW + 1000)}\n${timedCheckpoint(100, 10, NOW + 2000)}\n`;
  await harvestCodex(d);
  expect(tokenSum(d)).toBe(220);
  await harvestCodex(d);
  expect(tokenSum(d)).toBe(220);
});

test("account enrollment boundary excludes pre-enrollment usage without losing the later delta", async () => {
  const d: CodexHarvesterDeps = { ...deps(), scan: async volume => volume === "codex-home" ? "" :
    `== ${rolloutPath()}\n${CTX_LINE}\n${timedCheckpoint(100, 10, NOW - 2000)}\n${timedCheckpoint(250, 25, NOW + 1000)}\n` };
  addAccount(d, "second", NOW);
  await harvestCodexAccounts(d);
  expect(tokenSum(d)).toBe(165);
});

test("historical account catch-up refuses undated usage instead of inventing today's consumption", async () => {
  const d: CodexHarvesterDeps = { ...deps(), scan: async volume => volume === "codex-home" ? "" : scanOut({ input: 100, cachedInput: 0, cacheWrite: 0, output: 10 }) };
  addAccount(d, "second", NOW - 1000);
  await expect(harvestCodexAccounts(d)).rejects.toThrow("without usage event timestamps");
  expect(tokenSum(d)).toBe(0);
  expect(getHarvestState<{ sources?: Record<string, unknown> }>(d.db, "codex")!.sources?.second).toBeUndefined();
});

// ---- subagents (thread_spawn): they send no hook events, attribution is inherited from the parent ----

const CHILD_ID = "01a13206-151c-7ee2-a7b5-fa58e3fadccc";
const GRANDCHILD_ID = "01a136d4-7e5a-77e0-a792-ccd559438d4f";
const spawnMeta = (parent: string) => JSON.stringify({ type: "session_meta", payload: { id: "x", cwd: "/workspace",
  base_instructions: { text: "SECRET instructions" },
  source: { subagent: { thread_spawn: { parent_thread_id: parent, depth: 1, agent_path: "/root/review" } } } } });
const parentLine = (parent: string) => JSON.stringify({ type: "session_meta", payload: { parent_thread_id: parent } });
const subagentScan = (id: string, parent: string, output = 100) =>
  scanOut({ input: 1_000, cachedInput: 0, cacheWrite: 0, output }, "gpt-5.6-sol", id).replace("\n", `\n${parentLine(parent)}\n`);

test("metadata scanner emits only the subagent's parent thread id from session_meta", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-scan-"));
  try {
    mkdirSync(join(root, "sessions"));
    writeFileSync(join(root, "sessions", rolloutPath(CHILD_ID).split("/").at(-1)!),
      [spawnMeta(ROLLOUT_ID), context("gpt-5.6-sol"), checkpoint(100, 10, 150)].join("\n"));
    const out = await scanFixture(root, 0);
    expect(out).not.toContain("SECRET");
    expect(out).not.toContain("/root/review");
    expect(parseCodexScan(out)[0].parentId).toBe(ROLLOUT_ID);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("harvestCodex: a subagent without notify_log inherits session/project/repo from the parent, even across two levels", async () => {
  const d = deps({
    run: async () => ({ code: 0, stdout: subagentScan(CHILD_ID, ROLLOUT_ID) + subagentScan(GRANDCHILD_ID, CHILD_ID), stderr: "" }),
  });
  insertSession(d.db, session);
  insertNotifyLog(d.db, {
    ts: NOW, session_id: session.id, event: "hook", decision: "none", reason: null,
    inflight: 0, teammates: 0, agent_session_id: ROLLOUT_ID, detail: null,
  });
  await harvestCodex(d);

  const rows = d.db.query("SELECT session_id, a_project, a_repo FROM metrics").all() as
    { session_id: string | null; a_project: string | null; a_repo: string | null }[];
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.every((r) => r.session_id === "dev-p-r" && r.a_project === "p" && r.a_repo === "r")).toBe(true);
  const st = getHarvestState<{ files: Record<string, { parentId?: string; session: string | null }> }>(d.db, "codex")!;
  expect(st.files[GRANDCHILD_ID]).toMatchObject({ parentId: CHILD_ID, session: "dev-p-r" });
});

test("harvestCodex: a subagent of a parent with a deleted session takes project/repo from the parent's state cache", async () => {
  const first = deps({ run: async () => ({ code: 0, stdout: scanOut({ input: 1_000, cachedInput: 0, cacheWrite: 0, output: 100 }), stderr: "" }) });
  insertSession(first.db, session);
  insertNotifyLog(first.db, {
    ts: NOW, session_id: session.id, event: "hook", decision: "none", reason: null,
    inflight: 0, teammates: 0, agent_session_id: ROLLOUT_ID, detail: null,
  });
  await harvestCodex(first);
  deleteSession(first.db, session.id);

  const second = deps({ db: first.db, now: () => NOW + 60_000, run: async () => ({ code: 0, stdout: subagentScan(CHILD_ID, ROLLOUT_ID), stderr: "" }) });
  await harvestCodex(second);

  const row = second.db.query(`SELECT session_id, a_project, a_repo FROM metrics WHERE attrs LIKE '%${CHILD_ID}%' LIMIT 1`).get();
  expect(row).toEqual({ session_id: "dev-p-r", a_project: "p", a_repo: "r" });
});

test("harvestCodex: a subagent recorded earlier without attribution gets it in the next cycle once the parent has it", async () => {
  const first = deps({ run: async () => ({ code: 0, stdout: subagentScan(CHILD_ID, ROLLOUT_ID, 100), stderr: "" }) });
  insertSession(first.db, session);
  await harvestCodex(first);
  expect((first.db.query("SELECT a_repo FROM metrics LIMIT 1").get() as { a_repo: string | null }).a_repo).toBeNull();

  insertNotifyLog(first.db, {
    ts: NOW, session_id: session.id, event: "hook", decision: "none", reason: null,
    inflight: 0, teammates: 0, agent_session_id: ROLLOUT_ID, detail: null,
  });
  const second = deps({ db: first.db, now: () => NOW + 60_000,
    run: async () => ({ code: 0, stdout: scanOut({ input: 1_000, cachedInput: 0, cacheWrite: 0, output: 300 }, "gpt-5.6-sol", CHILD_ID), stderr: "" }) });
  await harvestCodex(second);
  const latest = second.db.query("SELECT a_repo FROM metrics WHERE name='claude_code.token.usage' ORDER BY id DESC LIMIT 1").get();
  expect(latest).toEqual({ a_repo: "r" });
});
