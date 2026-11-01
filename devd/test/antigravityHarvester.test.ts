import { expect, test } from "bun:test";
import { harvestAgy, modelAt, parseTranscriptChunk } from "../src/antigravityHarvester";
import { getHarvestState, insertSession, openDb, setHarvestState } from "../src/db";
import type { CodexPollerDeps } from "../src/codexPoller";
import type { AgySidMap } from "../src/antigravityHarvester";

const L = (o: object) => JSON.stringify(o) + "\n";

test("parseTranscriptChunk: only PLANNER_RESPONSE with tokens; an unfinished line is not consumed", () => {
  const chunk = L({ type: "USER_INPUT", step_index: 0, created_at: "2026-10-15T09:37:10Z", input_tokens: null })
    + L({ type: "PLANNER_RESPONSE", source: "MODEL", step_index: 9, created_at: "2026-10-15T09:37:25Z", input_tokens: 2795, output_tokens: 90, cache_read_tokens: 15107 })
    + "nonsense\n"
    + '{"type":"PLANNER_RESPONSE","input_tok';
  const r = parseTranscriptChunk(chunk);
  expect(r.steps).toEqual([{ ts: Date.parse("2026-10-15T09:37:25Z"), totals: { input: 2795, cacheRead: 15107, cacheWrite: 0, output: 90 }, promptTokens: 17902 }]);
  expect(r.consumedBytes).toBe(chunk.length - '{"type":"PLANNER_RESPONSE","input_tok'.length);
});

test("parseTranscriptChunk: the fallback timestamp (missing/invalid created_at) comes from the injected `now`, not from the clock", () => {
  const chunk = L({ type: "PLANNER_RESPONSE", source: "MODEL", step_index: 1, created_at: "invalid", input_tokens: 10, output_tokens: 1, cache_read_tokens: 0 });
  const FAKE_NOW = 123_456_789;
  const r = parseTranscriptChunk(chunk, () => FAKE_NOW);
  expect(r.steps).toHaveLength(1);
  expect(r.steps[0]!.ts).toBe(FAKE_NOW);
});

// ---- harvestAgy (integration: docker scan → parse → metrics → state) ----

const NOW = 1_787_224_361_140;
const ID = "01a2b3c4-0000-0000-0000-000000000000";
const ID2 = "02b2b3c4-0000-0000-0000-000000000000";
const OLD_SEP = "@@@agy-harvest@@@"; // fixed separator from an earlier version — now just a test payload
const TPATH = (id: string) => `/home/dev/.gemini/antigravity-cli/brain/${id}/.system_generated/logs/transcript_full.jsonl`;

/** The harvester now generates a per-run unique separator (not a global constant) —
 *  the fake `run` does not know it in advance, it must read it from the script, exactly as
 *  a real shell would: `echo '<sep> <id>'; ...`. */
const sepOf = (script: string): string => script.match(/echo '(\S+) /)?.[1] ?? "";

function deps(over: Partial<CodexPollerDeps> = {}): CodexPollerDeps {
  return {
    db: openDb(":memory:"),
    run: async () => ({ code: 0, stdout: "", stderr: "" }),
    fetch: (async () => new Response("{}")) as unknown as typeof fetch,
    now: () => NOW,
    ...over,
  };
}

const agySids = (over: Partial<AgySidMap[string]> = {}): AgySidMap => ({
  [ID]: { session: "dev-p-r", project: "p", repo: "r", model: "gemini-3.8-flash-high", ts: 1, ...over },
});

test("harvestAgy: no mapped conversation → docker is not called at all", async () => {
  let called = false;
  const d = deps({ run: async () => { called = true; return { code: 0, stdout: "", stderr: "" }; } });
  await harvestAgy(d);
  expect(called).toBe(false);
});

test("harvestAgy: mapped conversation → metric rows with session/project/repo/model/agent, the offset advances; a second run with the same output duplicates nothing", async () => {
  const PR = L({ type: "PLANNER_RESPONSE", source: "MODEL", step_index: 9, created_at: "2026-10-15T09:37:25Z", input_tokens: 2795, output_tokens: 90, cache_read_tokens: 15107 });
  const d = deps({
    // Simulates a real `tail -c +N | head -c CAP` — the second run (offset == size) returns an empty remainder.
    run: async (cmd) => {
      const script = cmd[cmd.length - 1];
      expect(script).toContain(ID);
      const sep = sepOf(script);
      const off = Number(script.match(/tail -c \+(\d+)/)?.[1]) - 1;
      const size = Buffer.byteLength(PR);
      const tail = Buffer.from(PR).subarray(Math.min(off, size)).toString();
      return { code: 0, stdout: `${sep} ${ID}\n${size}\n${tail}`, stderr: "" };
    },
  });
  insertSession(d.db, {
    id: "dev-p-r", folder: "f", project: "p", repo: "r", container: "c1", port_base: 30000,
    status: "running", solo: 0, created_at: NOW, last_active_at: NOW, important: 0, agent: "antigravity",
  });
  setHarvestState(d.db, "agy-sids", agySids());

  await harvestAgy(d);

  const tok = d.db.query("SELECT value, session_id, attrs FROM metrics WHERE name='claude_code.token.usage'").all() as
    { value: number; session_id: string | null; attrs: string }[];
  expect(tok.length).toBeGreaterThan(0);
  expect(tok.every((r) => r.session_id === "dev-p-r")).toBe(true);
  const attrs = JSON.parse(tok[0]!.attrs);
  expect(attrs.project).toBe("p");
  expect(attrs.repo).toBe("r");
  expect(attrs.model).toBe("gemini-3.8-flash-high");
  expect(attrs["devbox.agent"]).toBe("agy");
  const byType = Object.fromEntries(tok.map((r) => [JSON.parse(r.attrs).type, r.value]));
  expect(byType.input).toBe(2795);
  expect(byType.cacheRead).toBe(15107);
  expect(byType.output).toBe(90);
  // Cost by the Gemini 3.8 Flash price list (introductory rate, the step is from October 2026).
  const cost = d.db.query("SELECT value, attrs FROM metrics WHERE name='claude_code.cost.usage'").all() as { value: number; attrs: string }[];
  const costBy = Object.fromEntries(cost.map((r) => [JSON.parse(r.attrs).type, r.value]));
  expect(costBy.input).toBeCloseTo(2795 * 0.75 / 1e6, 12);
  expect(costBy.cacheRead).toBeCloseTo(15107 * 0.075 / 1e6, 12);
  expect(costBy.output).toBeCloseTo(90 * 3.75 / 1e6, 12);

  const st1 = getHarvestState<{ offsets: Record<string, number> }>(d.db, "agy-harvest")!;
  expect(st1.offsets[ID]).toBe(Buffer.byteLength(PR));

  // Second run: the same transcript, the offset already matches the size → nothing new is read.
  await harvestAgy(d);
  const n2 = (d.db.query("SELECT COUNT(*) n FROM metrics WHERE name='claude_code.token.usage'").get() as { n: number }).n;
  expect(n2).toBe(tok.length);
});

test("harvestAgy: a conversation not in agy-sids does not get into the script (the script does not read it at all)", async () => {
  const OTHER = "ffffffff-0000-0000-0000-000000000000";
  let scriptSeen = "";
  const d = deps({
    run: async (cmd) => { scriptSeen = cmd[cmd.length - 1]; return { code: 0, stdout: "", stderr: "" }; },
  });
  setHarvestState(d.db, "agy-sids", agySids());
  await harvestAgy(d);
  expect(scriptSeen).toContain(ID);
  expect(scriptSeen).not.toContain(OTHER);
  expect(scriptSeen).not.toContain(TPATH(OTHER));
});

test("harvestAgy: transcript size < offset (truncated/new file) → the offset resets to 0, without an exception", async () => {
  const d = deps({
    run: async (cmd) => {
      const sep = sepOf(cmd[cmd.length - 1]);
      return { code: 0, stdout: `${sep} ${ID}\n50\n`, stderr: "" };
    },
  });
  setHarvestState(d.db, "agy-sids", agySids());
  setHarvestState(d.db, "agy-harvest", { offsets: { [ID]: 100 } });

  await expect(harvestAgy(d)).resolves.toBeUndefined();

  const st = getHarvestState<{ offsets: Record<string, number> }>(d.db, "agy-harvest")!;
  expect(st.offsets[ID]).toBe(0);
  expect((d.db.query("SELECT COUNT(*) n FROM metrics").get() as { n: number }).n).toBe(0);
});

test("harvestAgy: truncation/a new file also clears the old skipToNewline flag — the next cycle counts the first PLANNER_RESPONSE line of the new file", async () => {
  const prLine = L({ type: "PLANNER_RESPONSE", source: "MODEL", step_index: 1, created_at: "2026-10-15T12:00:00Z", input_tokens: 33, output_tokens: 2, cache_read_tokens: 0 });
  let call = 0;
  const d = deps({
    run: async (cmd) => {
      const sep = sepOf(cmd[cmd.length - 1]);
      call++;
      if (call === 1) {
        // The file shrank (rotation/new file) — the size (50) is smaller than
        // the stored offset (500) from the time the conversation was still "catching up" on a too-long line.
        return { code: 0, stdout: `${sep} ${ID}\n50\n`, stderr: "" };
      }
      // Second cycle: the offset was reset to 0, the content of the new file arrives from the start.
      return { code: 0, stdout: `${sep} ${ID}\n${Buffer.byteLength(prLine)}\n${prLine}`, stderr: "" };
    },
  });
  setHarvestState(d.db, "agy-sids", agySids());
  setHarvestState(d.db, "agy-harvest", { offsets: { [ID]: 500 }, skipToNewline: { [ID]: true } });

  await harvestAgy(d); // cycle 1: detects the truncation, resets the offset — and MUST clear the old flag
  const st1 = getHarvestState<{ offsets: Record<string, number>; skipToNewline?: Record<string, boolean> }>(d.db, "agy-harvest")!;
  expect(st1.offsets[ID]).toBe(0);
  expect(st1.skipToNewline?.[ID]).toBeFalsy();

  await harvestAgy(d); // cycle 2: without the old flag the first (only) line of the new file is parsed normally
  const tok = d.db.query("SELECT value, attrs FROM metrics WHERE name='claude_code.token.usage'").all() as { value: number; attrs: string }[];
  const byType = Object.fromEntries(tok.map((r) => [JSON.parse(r.attrs).type, r.value]));
  expect(byType.input).toBe(33);
  expect(byType.output).toBe(2);
});

test("harvestAgy: an unsafe id in the map (shell metacharacters) does not get into the script", async () => {
  const BAD = "x; rm";
  let scriptSeen = "";
  const d = deps({
    run: async (cmd) => { scriptSeen = cmd[cmd.length - 1]; return { code: 0, stdout: "", stderr: "" }; },
  });
  setHarvestState(d.db, "agy-sids", {
    [BAD]: { session: "dev-p-r", project: "p", repo: "r", model: "gemini-3.8-flash-high", ts: 1 },
  } as AgySidMap);

  await harvestAgy(d);

  expect(scriptSeen).not.toContain("rm");
  expect(scriptSeen).toBe("");
});

// ---- Fix round 1 ----

test("harvestAgy: a transcript line containing the old fixed separator (even just its prefix) does not break — the per-run separator is unique", async () => {
  // The agent may work on this repo, so the transcript can contain arbitrary
  // text, even the literal old separator or its prefix. A fixed SEP would split
  // the line in the middle, breaking the JSON, and the offset of that conversation would
  // get stuck forever (see Fix round 1, point 1).
  const dangerous = L({
    type: "PLANNER_RESPONSE", source: "MODEL", step_index: 1, created_at: "2026-10-15T10:00:00Z",
    input_tokens: 500, output_tokens: 20, cache_read_tokens: 0,
    note: `contains ${OLD_SEP} and even just the prefix @@@agy- without the end`,
  });
  const d = deps({
    run: async (cmd) => {
      const sep = sepOf(cmd[cmd.length - 1]);
      return { code: 0, stdout: `${sep} ${ID}\n${Buffer.byteLength(dangerous)}\n${dangerous}`, stderr: "" };
    },
  });
  insertSession(d.db, {
    id: "dev-p-r", folder: "f", project: "p", repo: "r", container: "c1", port_base: 30001,
    status: "running", solo: 0, created_at: NOW, last_active_at: NOW, important: 0, agent: "antigravity",
  });
  setHarvestState(d.db, "agy-sids", agySids());

  await harvestAgy(d);

  const tok = d.db.query("SELECT value, attrs FROM metrics WHERE name='claude_code.token.usage'").all() as { value: number; attrs: string }[];
  const byType = Object.fromEntries(tok.map((r) => [JSON.parse(r.attrs).type, r.value]));
  expect(byType.input).toBe(500);
  expect(byType.output).toBe(20);
  const st = getHarvestState<{ offsets: Record<string, number> }>(d.db, "agy-harvest")!;
  expect(st.offsets[ID]).toBe(Buffer.byteLength(dangerous));
});

test("harvestAgy: two mapped conversations in one docker run — both get rows, the offsets advance independently", async () => {
  const PR1 = L({ type: "PLANNER_RESPONSE", source: "MODEL", step_index: 1, created_at: "2026-10-15T10:00:00Z", input_tokens: 100, output_tokens: 5, cache_read_tokens: 0 });
  const PR2 = L({ type: "PLANNER_RESPONSE", source: "MODEL", step_index: 1, created_at: "2026-10-15T10:01:00Z", input_tokens: 200, output_tokens: 7, cache_read_tokens: 0 });
  const d = deps({
    run: async (cmd) => {
      const sep = sepOf(cmd[cmd.length - 1]);
      return { code: 0, stdout: `${sep} ${ID}\n${Buffer.byteLength(PR1)}\n${PR1}${sep} ${ID2}\n${Buffer.byteLength(PR2)}\n${PR2}`, stderr: "" };
    },
  });
  setHarvestState(d.db, "agy-sids", {
    [ID]: { session: "dev-p-r", project: "p", repo: "r", model: "gemini-3.8-flash-high", ts: 1 },
    [ID2]: { session: "dev-x-y", project: "x", repo: "y", model: "gemini-3.8-pro", ts: 1 },
  });

  await harvestAgy(d);

  const rows = d.db.query("SELECT value, attrs FROM metrics WHERE name='claude_code.token.usage'").all() as { value: number; attrs: string }[];
  const byModelType = new Map<string, number>();
  for (const r of rows) { const a = JSON.parse(r.attrs); byModelType.set(`${a.model}:${a.type}`, r.value); }
  expect(byModelType.get("gemini-3.8-flash-high:input")).toBe(100);
  expect(byModelType.get("gemini-3.8-pro:input")).toBe(200);
  const st = getHarvestState<{ offsets: Record<string, number> }>(d.db, "agy-harvest")!;
  expect(st.offsets[ID]).toBe(Buffer.byteLength(PR1));
  expect(st.offsets[ID2]).toBe(Buffer.byteLength(PR2));
});

test("harvestAgy: the script reads through a per-conversation `head -c` cap; a line truncated by the cap is not consumed, the second run reads the rest", async () => {
  const CAP = 8 * 1024 * 1024;
  const full = JSON.stringify({ type: "PLANNER_RESPONSE", source: "MODEL", step_index: 1, created_at: "2026-10-15T10:00:00Z", input_tokens: 9, output_tokens: 1, cache_read_tokens: 0 });
  const line1 = L({ type: "PLANNER_RESPONSE", source: "MODEL", step_index: 1, created_at: "2026-10-15T09:00:00Z", input_tokens: 11, output_tokens: 2, cache_read_tokens: 0 });
  // The second line is "truncated by the cap" — simulation: the fake run returns only the first half of the second line.
  const cutSecondLine = full.slice(0, Math.floor(full.length / 2));
  const fullSize = Buffer.byteLength(line1) + Buffer.byteLength(full) + 1; // size of the WHOLE file (without the cap)

  let seenCap = "";
  const d = deps({
    run: async (cmd) => {
      const script = cmd[cmd.length - 1];
      seenCap = script.match(/head -c (\d+)/)?.[1] ?? "";
      const sep = sepOf(script);
      const off = Number(script.match(/tail -c \+(\d+)/)?.[1]) - 1;
      // Before the cap: the whole remainder FROM THE OFFSET (a real `tail -c +N` returns only the remainder,
      // not the whole file again). The cap hits us in this test only on the first run
      // (off=0) — we return exactly what `head -c` would cut; the second run continues
      // exactly at the offset after the first line and reads the rest of the file without truncation.
      const body = off === 0 ? line1 + cutSecondLine : full + "\n";
      return { code: 0, stdout: `${sep} ${ID}\n${fullSize}\n${body}`, stderr: "" };
    },
  });
  setHarvestState(d.db, "agy-sids", agySids());

  await harvestAgy(d);
  expect(seenCap).toBe(String(CAP));

  // First run: only the first (complete) line is counted, the second (truncated) one is not consumed.
  let tok = d.db.query("SELECT value, attrs FROM metrics WHERE name='claude_code.token.usage'").all() as { value: number; attrs: string }[];
  let byType = Object.fromEntries(tok.map((r) => [JSON.parse(r.attrs).type, r.value]));
  expect(byType.input).toBe(11);
  const st1 = getHarvestState<{ offsets: Record<string, number> }>(d.db, "agy-harvest")!;
  expect(st1.offsets[ID]).toBe(Buffer.byteLength(line1));

  // Second run: the offset continues exactly at the end of the first line, reads the rest of the second too.
  await harvestAgy(d);
  tok = d.db.query("SELECT value, attrs FROM metrics WHERE name='claude_code.token.usage'").all() as { value: number; attrs: string }[];
  const sumByType = (rows: typeof tok) => rows.reduce<Record<string, number>>((acc, r) => {
    const t = JSON.parse(r.attrs).type; acc[t] = (acc[t] ?? 0) + r.value; return acc;
  }, {});
  const totals = sumByType(tok);
  expect(totals.input).toBe(11 + 9);
  expect(totals.output).toBe(2 + 1);
});

test("harvestAgy: metrics and the offset advance are written atomically — a failed state write leaves no orphaned rows in metrics", async () => {
  const PR = L({ type: "PLANNER_RESPONSE", source: "MODEL", step_index: 1, created_at: "2026-10-15T10:00:00Z", input_tokens: 42, output_tokens: 3, cache_read_tokens: 0 });
  const d = deps({
    run: async (cmd) => {
      const sep = sepOf(cmd[cmd.length - 1]);
      return { code: 0, stdout: `${sep} ${ID}\n${Buffer.byteLength(PR)}\n${PR}`, stderr: "" };
    },
  });
  setHarvestState(d.db, "agy-sids", agySids());
  d.db.exec("CREATE TRIGGER fail_agy_state BEFORE INSERT ON harvest_state WHEN NEW.source = 'agy-harvest' BEGIN SELECT RAISE(ABORT, 'state write failed'); END");

  await expect(harvestAgy(d)).rejects.toThrow("state write failed");
  expect((d.db.query("SELECT COUNT(*) n FROM metrics").get() as { n: number }).n).toBe(0);
  expect(getHarvestState(d.db, "agy-harvest")).toBeNull();

  d.db.exec("DROP TRIGGER fail_agy_state");
  await harvestAgy(d);
  const rows = d.db.query("SELECT value FROM metrics WHERE name='claude_code.token.usage' AND attrs LIKE '%\"input\"%'").all() as { value: number }[];
  expect(rows.reduce((sum, row) => sum + row.value, 0)).toBe(42);
});

// ---- Fix round 2 ----

test("harvestAgy: a line longer than the cap (maxChunkBytes) is skipped across cycles, the following PLANNER_RESPONSE line is then counted", async () => {
  // A small injected cap — we do not have to build an 8MiB fixture to trigger
  // the same condition (chunk == cap, no \n inside). It must be bigger than the
  // (legitimate) PLANNER_RESPONSE line itself, otherwise the cap would hit that one too.
  const CAP = 200;
  const hugeLine = L({ type: "TOOL_OUTPUT", step_index: 1, blob: "x".repeat(500) });
  const prLine = L({ type: "PLANNER_RESPONSE", source: "MODEL", step_index: 2, created_at: "2026-10-15T11:00:00Z", input_tokens: 77, output_tokens: 4, cache_read_tokens: 0 });
  const file = hugeLine + prLine;
  const fileSize = Buffer.byteLength(file);
  expect(Buffer.byteLength(hugeLine)).toBeGreaterThan(CAP * 2); // the fixture must be seriously longer than the cap
  expect(Buffer.byteLength(prLine)).toBeLessThan(CAP); // but the legitimate line fits into the cap entirely

  // The fake `run` simulates a real `tail -c +N | head -c CAP` over the whole `file` — the same
  // behaviour across any number of cycles, no manual branching per cycle.
  const d = deps({
    run: async (cmd) => {
      const script = cmd[cmd.length - 1];
      const sep = sepOf(script);
      const off = Number(script.match(/tail -c \+(\d+)/)?.[1]) - 1;
      const capBytes = Number(script.match(/head -c (\d+)/)?.[1]);
      const buf = Buffer.from(file, "utf8");
      const capped = buf.subarray(Math.min(off, buf.length)).subarray(0, capBytes);
      return { code: 0, stdout: `${sep} ${ID}\n${fileSize}\n${capped.toString("utf8")}`, stderr: "" };
    },
  });
  setHarvestState(d.db, "agy-sids", agySids());

  let countedRow = false;
  for (let i = 0; i < 20 && !countedRow; i++) {
    await harvestAgy(d, CAP);
    const tok = d.db.query("SELECT value FROM metrics WHERE name='claude_code.token.usage'").all() as { value: number }[];
    countedRow = tok.length > 0;
    const st = getHarvestState<{ offsets: Record<string, number> }>(d.db, "agy-harvest")!;
    if (!countedRow) expect(st.offsets[ID]).toBeLessThan(fileSize); // the huge line is still being "eaten"
  }
  expect(countedRow).toBe(true);

  const tok = d.db.query("SELECT value, attrs FROM metrics WHERE name='claude_code.token.usage'").all() as { value: number; attrs: string }[];
  const byType = Object.fromEntries(tok.map((r) => [JSON.parse(r.attrs).type, r.value]));
  expect(byType.input).toBe(77);
  expect(byType.output).toBe(4);

  const st = getHarvestState<{ offsets: Record<string, number>; skipToNewline?: Record<string, boolean> }>(d.db, "agy-harvest")!;
  expect(st.offsets[ID]).toBe(fileSize);
  expect(st.skipToNewline?.[ID]).toBeFalsy(); // the flag was cleared after reaching the end of the huge line
});

test("modelAt: model by the switch history; second precision of the step; fallbacks", () => {
  const T = Date.parse("2026-10-15T12:23:16.400Z"); // switch to Sonnet (ms precision of the hook)
  const e = { session: "s", project: "p", repo: "r", model: "claude-sonnet-5-5-low", ts: T,
    models: [{ from: Date.parse("2026-10-15T12:23:00.100Z"), model: "gemini-3.8-flash-low" }, { from: T, model: "claude-sonnet-5-5-low" }] };
  expect(modelAt(e, Date.parse("2026-10-15T12:23:08Z"))).toBe("gemini-3.8-flash-low");
  // A step in THE SAME second as the switch (created_at has only seconds) belongs to the new model.
  expect(modelAt(e, Date.parse("2026-10-15T12:23:16Z"))).toBe("claude-sonnet-5-5-low");
  expect(modelAt(e, Date.parse("2026-10-15T12:30:00Z"))).toBe("claude-sonnet-5-5-low");
  // Before the first entry → the first model; without history (old record) → `model`.
  expect(modelAt(e, Date.parse("2026-10-15T12:00:00Z"))).toBe("gemini-3.8-flash-low");
  expect(modelAt({ session: "s", project: "p", repo: "r", model: "gemini-3.8-flash-high", ts: 1 }, NOW)).toBe("gemini-3.8-flash-high");
});

test("harvestAgy: steps before and after a model switch each get their own model and cost", async () => {
  const body = L({ type: "PLANNER_RESPONSE", source: "MODEL", created_at: "2026-10-15T12:23:08Z", input_tokens: 1_000_000, output_tokens: 0, cache_read_tokens: 0 })
    + L({ type: "PLANNER_RESPONSE", source: "MODEL", created_at: "2026-10-15T12:23:19Z", input_tokens: 1_000_000, output_tokens: 0, cache_read_tokens: 0 });
  const d = deps({ run: async (cmd) => {
    const script = cmd[cmd.length - 1];
    return { code: 0, stdout: `${sepOf(script)} ${ID}\n${Buffer.byteLength(body)}\n${body}`, stderr: "" };
  } });
  setHarvestState(d.db, "agy-sids", agySids({ models: [
    { from: Date.parse("2026-10-15T12:23:00Z"), model: "gemini-3.8-flash-low" },
    { from: Date.parse("2026-10-15T12:23:16.400Z"), model: "claude-opus-5-5-high" },
  ] }));
  await harvestAgy(d);
  const cost = d.db.query("SELECT value, attrs FROM metrics WHERE name='claude_code.cost.usage' ORDER BY ts").all() as { value: number; attrs: string }[];
  expect(cost.map((r) => [JSON.parse(r.attrs).model, r.value])).toEqual([["gemini-3.8-flash-low", 0.75], ["claude-opus-5-5-high", 4]]);
});
