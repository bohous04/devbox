import { expect, test } from "bun:test";
import { attributeGrokTurn, harvestGrok, parseUnifiedChunk, PENDING_MAX_MS } from "../src/grokHarvester";
import { deleteSession, getHarvestState, insertNotifyLog, insertSession, openDb, setHarvestState } from "../src/db";
import type { CodexPollerDeps } from "../src/codexPoller";

const LINE = (sid: string, ts: string, p: number, c: number, o: number) => JSON.stringify({
  ts, src: "shell", pid: 110, lvl: "info", sid, msg: "shell.turn.inference_done",
  ctx: { loop_index: 2, attempts: 1, prompt_tokens: p, cached_prompt_tokens: c, completion_tokens: o, reasoning_tokens: 1 },
}) + "\n";

test("parses inference_done, cached is subtracted from input, reasoning is added to output, ignores foreign lines", () => {
  const chunk = LINE("01a2b3c4", "2026-08-23T19:18:10.317Z", 249_246, 246_528, 728)
    + JSON.stringify({ ts: "2026-08-23T19:18:11Z", msg: "auth: refresh used disk token" }) + "\n";
  const { turns, consumedBytes } = parseUnifiedChunk(chunk);
  expect(turns).toHaveLength(1);
  expect(turns[0]).toEqual({
    sid: "01a2b3c4", ts: Date.parse("2026-08-23T19:18:10.317Z"),
    totals: { input: 2_718, cacheRead: 246_528, cacheWrite: 0, output: 729 }, promptTokens: 249_246,
  });
  expect(consumedBytes).toBe(Buffer.byteLength(chunk));
});

test("a truncated last line is not consumed — it is read next time", () => {
  const full = LINE("01a2b3c4", "2026-08-23T19:18:10.317Z", 100, 0, 10);
  const chunk = full + '{"ts":"2026-08-23T19:19';
  const { turns, consumedBytes } = parseUnifiedChunk(chunk);
  expect(turns).toHaveLength(1);
  expect(consumedBytes).toBe(Buffer.byteLength(full));
});

test("attribution: the map from the session-start hook takes precedence", () => {
  const db = openDb(":memory:");
  expect(attributeGrokTurn(db, "s1", 5_000, { s1: { session: "dev-p-r", project: "p", repo: "r", ts: 1 } })).toBe("dev-p-r");
});

test("attribution by fallback: the only grok session with an open turn", () => {
  const db = openDb(":memory:");
  insertSession(db, {
    id: "dev-p-r", folder: "f", project: "p", repo: "r", container: "c1", port_base: 30000,
    status: "running", solo: 0, created_at: 1, last_active_at: 1, important: 0, agent: "grok",
  });
  insertSession(db, {
    id: "dev-x-y", folder: "f", project: "x", repo: "y", container: "c2", port_base: 30010,
    status: "running", solo: 0, created_at: 1, last_active_at: 1, important: 0, agent: "claude",
  });
  const row = { decision: "none" as const, reason: null, inflight: 0, teammates: 0, agent_session_id: null, detail: null };
  insertNotifyLog(db, { ...row, ts: 1_000, session_id: "dev-p-r", event: "user_prompt_submit" });
  expect(attributeGrokTurn(db, "s9", 50_000, {})).toBe("dev-p-r");
  // after stop the turn is no longer open → null
  insertNotifyLog(db, { ...row, ts: 2_000, session_id: "dev-p-r", event: "stop" });
  expect(attributeGrokTurn(db, "s9", 200_000, {})).toBeNull();
});

// sid is raw data from a shared volume and is later interpolated into a shell script
// (see SAFE_SID_RE in grokHarvester.ts) — the injection defence is tested already here,
// at the input into the system, not only at the shell call itself.
test("parseUnifiedChunk: a sid with disallowed characters (shell metacharacters) is dropped", () => {
  const bad = JSON.stringify({
    ts: "2026-08-23T19:18:10.317Z", sid: "s1; rm -rf /", msg: "shell.turn.inference_done",
    ctx: { prompt_tokens: 100, cached_prompt_tokens: 0, completion_tokens: 10 },
  }) + "\n";
  expect(parseUnifiedChunk(bad).turns).toHaveLength(0);
});

// ---- harvestGrok (integration: docker scan → parse → attribution → metrics → state) ----

const NOW = 1_787_224_361_140;

function deps(over: Partial<CodexPollerDeps> = {}): CodexPollerDeps {
  return {
    db: openDb(":memory:"),
    run: async () => ({ code: 0, stdout: "", stderr: "" }),
    fetch: (async () => new Response("{}")) as unknown as typeof fetch,
    now: () => NOW,
    ...over,
  };
}

test("harvestGrok: a docker error leaves the state untouched", async () => {
  const d = deps({ run: async () => ({ code: 1, stdout: "", stderr: "docker daemon is not running" }) });
  await harvestGrok(d);
  expect(getHarvestState(d.db, "grok")).toBeNull();
});

// History backfill: NO — collected from deployment (spec, binding decision "History
// backfill"). unified.jsonl has always been shared across ALL containers, so without
// this protection the first run after deployment would parse and write weeks-old turns.
test("harvestGrok: the first run after deployment moves the offset to the end of the log, parses and writes nothing", async () => {
  const d = deps({ run: async () => ({ code: 0, stdout: "123456\n", stderr: "" }) });
  await harvestGrok(d);
  expect(getHarvestState<{ offset: number; pending: unknown[]; models: Record<string, string> }>(d.db, "grok"))
    .toEqual({ offset: 123_456, pending: [], models: {} });
  expect((d.db.query("SELECT COUNT(*) n FROM metrics").get() as { n: number }).n).toBe(0);
});

test("harvestGrok: first run — an unparseable log size is taken as 0, nothing is written", async () => {
  const d = deps({ run: async () => ({ code: 0, stdout: "", stderr: "" }) });
  await harvestGrok(d);
  expect(getHarvestState<{ offset: number; pending: unknown[]; models: Record<string, string> }>(d.db, "grok"))
    .toEqual({ offset: 0, pending: [], models: {} });
  expect((d.db.query("SELECT COUNT(*) n FROM metrics").get() as { n: number }).n).toBe(0);
});

test("harvestGrok: size < offset (log rotation/truncation) resets the offset to 0, writes nothing", async () => {
  const d = deps({ run: async () => ({ code: 0, stdout: "50\n", stderr: "" }) });
  setHarvestState(d.db, "grok", { offset: 100, pending: [], models: {} });
  await harvestGrok(d);
  expect(getHarvestState<{ offset: number }>(d.db, "grok")!.offset).toBe(0);
  expect((d.db.query("SELECT COUNT(*) n FROM metrics").get() as { n: number }).n).toBe(0);
});

test("harvestGrok: a pending turn older than PENDING_MAX_MS is written without a session", async () => {
  const staleTurn = {
    sid: "aaaa1111-bbbb-2222-cccc-333344445555", ts: NOW - 20 * 60_000,
    totals: { input: 500, cacheRead: 0, cacheWrite: 0, output: 50 }, promptTokens: 500,
    firstSeenAt: NOW - PENDING_MAX_MS - 1,
  };
  const d = deps({ run: async () => ({ code: 0, stdout: "0\n", stderr: "" }) });
  setHarvestState(d.db, "grok", { offset: 0, pending: [staleTurn], models: {} });
  await harvestGrok(d);
  const tok = d.db.query("SELECT session_id, value FROM metrics WHERE name='claude_code.token.usage'")
    .all() as { session_id: string | null; value: number }[];
  expect(tok.length).toBeGreaterThan(0);
  expect(tok.every((r) => r.session_id === null)).toBe(true);
  expect(getHarvestState<{ pending: unknown[] }>(d.db, "grok")!.pending).toHaveLength(0);
});

test("harvestGrok: a new turn with the grok-sids map → tokens and cost attributed to the session", async () => {
  const line = LINE("01a2b3c4-0000-0000-0000-000000000000", "2026-08-23T19:18:10.317Z", 1_000, 0, 100);
  const d = deps({
    run: async (cmd) => {
      const script = cmd[cmd.length - 1];
      if (script.includes("wc -c")) return { code: 0, stdout: `${Buffer.byteLength(line)}\n${line}`, stderr: "" };
      if (script.includes("current_model_id")) {
        return { code: 0, stdout: `01a2b3c4-0000-0000-0000-000000000000\t"current_model_id":"grok-4.6"\n`, stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  insertSession(d.db, {
    id: "dev-p-r", folder: "f", project: "p", repo: "r", container: "c1", port_base: 30020,
    status: "running", solo: 0, created_at: NOW, last_active_at: NOW, important: 0, agent: "grok",
  });
  setHarvestState(d.db, "grok-sids", {
    "01a2b3c4-0000-0000-0000-000000000000": { session: "dev-p-r", project: "p", repo: "r", ts: 1 },
  });
  // Simulates "not the first run" — the first run after deployment only moves the offset, see the test above.
  setHarvestState(d.db, "grok", { offset: 0, pending: [], models: {} });

  await harvestGrok(d);

  const tok = d.db.query("SELECT value, session_id, attrs FROM metrics WHERE name='claude_code.token.usage'").all() as
    { value: number; session_id: string | null; attrs: string }[];
  expect(tok.length).toBeGreaterThan(0);
  expect(tok.every((r) => r.session_id === "dev-p-r")).toBe(true);
  const byType = Object.fromEntries(tok.map((r) => [JSON.parse(r.attrs).type, r.value]));
  expect(byType.input).toBe(1_000);
  expect(byType.output).toBe(101); // 100 completion + 1 reasoning (LINE fixture)
  // grok-4.6 is in the price list → cost too
  expect((d.db.query("SELECT COUNT(*) n FROM metrics WHERE name='claude_code.cost.usage'").get() as { n: number }).n)
    .toBeGreaterThan(0);
});

// The session ended INSIDE the last window (deleteSession) before the harvester
// managed to finish — getSession no longer sees it, but the map from the session-start hook does.
test("harvestGrok: a sid attributed via the grok-sids map even after the session is deleted — rows carry session/project/repo from the map", async () => {
  const line = LINE("01a2b3c4-0000-0000-0000-000000000000", "2026-08-23T19:18:10.317Z", 1_000, 0, 100);
  const d = deps({
    run: async (cmd) => {
      const script = cmd[cmd.length - 1];
      if (script.includes("wc -c")) return { code: 0, stdout: `${Buffer.byteLength(line)}\n${line}`, stderr: "" };
      if (script.includes("current_model_id")) {
        return { code: 0, stdout: `01a2b3c4-0000-0000-0000-000000000000\t"current_model_id":"grok-4.6"\n`, stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  insertSession(d.db, {
    id: "dev-p-r", folder: "f", project: "p", repo: "r", container: "c1", port_base: 30030,
    status: "running", solo: 0, created_at: NOW, last_active_at: NOW, important: 0, agent: "grok",
  });
  setHarvestState(d.db, "grok-sids", {
    "01a2b3c4-0000-0000-0000-000000000000": { session: "dev-p-r", project: "p", repo: "r", ts: 1 },
  });
  setHarvestState(d.db, "grok", { offset: 0, pending: [], models: {} });
  deleteSession(d.db, "dev-p-r"); // the session ended meanwhile, but the map remembers project/repo

  await harvestGrok(d);

  const tok = d.db.query("SELECT session_id, attrs FROM metrics WHERE name='claude_code.token.usage'").all() as
    { session_id: string | null; attrs: string }[];
  expect(tok.length).toBeGreaterThan(0);
  expect(tok.every((r) => r.session_id === "dev-p-r")).toBe(true);
  expect(tok.every((r) => { const a = JSON.parse(r.attrs); return a.project === "p" && a.repo === "r"; })).toBe(true);
});

test("harvestGrok: headless grok without a hook is attributed via git_root_dir from summary.json (the real lookup script)", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const sid = "01a11ebf-322b-7030-b8fa-848fffd35f14";
  const home = mkdtempSync(join(tmpdir(), "grok-home-"));
  try {
    const dir = join(home, "sessions", "%2Fworkspace%2Fgen", sid);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "summary.json"), JSON.stringify({ info: { id: sid, cwd: "/workspace/gen" },
      current_model_id: "grok-4.6", git_root_dir: "/srv/dev/_sessions/dev-p-r/", session_kind: "headless" }, null, 2));
    const line = LINE(sid, "2026-08-23T19:18:10.317Z", 1_000, 0, 100);
    const d = deps({
      run: async (cmd) => {
        const script = cmd[cmd.length - 1];
        if (script.includes("wc -c")) return { code: 0, stdout: `${Buffer.byteLength(line)}\n${line}`, stderr: "" };
        const p = Bun.spawn(["sh", "-c", script.replaceAll("/home/dev/.grok", home)], { stdout: "pipe" });
        return { code: await p.exited, stdout: await new Response(p.stdout).text(), stderr: "" };
      },
    });
    insertSession(d.db, {
      id: "dev-p-r", folder: "f", project: "p", repo: "r", container: "c1", port_base: 30020,
      status: "running", solo: 0, created_at: NOW, last_active_at: NOW, important: 0, agent: "claude",
    });
    setHarvestState(d.db, "grok", { offset: 0, pending: [], models: {} });

    await harvestGrok(d);

    const rows = d.db.query("SELECT session_id, a_project, a_repo, a_model FROM metrics WHERE name='claude_code.token.usage'").all();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => JSON.stringify(r) === JSON.stringify({ session_id: "dev-p-r", a_project: "p", a_repo: "r", a_model: "grok-4.6" }))).toBe(true);
    expect(getHarvestState<{ roots: Record<string, string> }>(d.db, "grok")!.roots[sid]).toBe("dev-p-r");
  } finally { rmSync(home, { recursive: true, force: true }); }
});
