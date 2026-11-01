import { expect, test } from "bun:test";
import { insertMetrics, insertNotifyLog, openDb } from "../src/db";
import { applyUsageAttribution, planUsageAttribution, undoUsageAttribution } from "../src/usageAttributionRepair";

const PARENT = "01a13159-e573-72a2-ae69-eef5899b9997";
const CHILD = "01a13206-151c-7ee2-a7b5-fa58e3fadccc";
const GRANDCHILD = "01a136d4-7e5a-77e0-a792-ccd559438d4f";
const ORPHAN = "01a13acb-f214-79c3-896f-3af46505b4d2";
const GROK = "01a11ebf-322b-7030-b8fa-848fffd35f14";

function row(source: string, agent = "codex", session?: { id: string; project: string; repo: string }, value = 100) {
  const attrs: Record<string, string> = { "devbox.host": "devbox", "devbox.agent": agent, "devbox.usage.source_id": source, model: "gpt-5.6-sol", type: "input" };
  if (session) Object.assign(attrs, { "devbox.session.id": session.id, project: session.project, repo: session.repo });
  return { ts: 1_000, session_id: session?.id ?? null, name: "claude_code.token.usage", value, attrs: JSON.stringify(attrs) };
}
const S = { id: "dev-games-game_web-20", project: "games", repo: "game_web" };

function fixture() {
  const db = openDb(":memory:");
  insertMetrics(db, [row(PARENT, "codex", S), row(CHILD), row(GRANDCHILD), row(ORPHAN), row(GROK, "grok"),
    row("01a00000-0000-0000-0000-000000000000", "grok")]);
  return db;
}
const ev = { codexParents: { [CHILD]: PARENT, [GRANDCHILD]: CHILD }, grokSessions: { [GROK]: S.id } };
const repoBySource = (db: ReturnType<typeof openDb>) => Object.fromEntries((db.query(
  `SELECT json_extract(attrs, '$."devbox.usage.source_id"') src, a_repo, session_id FROM metrics`).all() as
  { src: string; a_repo: string | null; session_id: string | null }[]).map((r) => [r.src, [r.a_repo, r.session_id]]));

test("subagents inherit the repo from the parent across levels, grok by git_root_dir, the rest stays", () => {
  const db = fixture();
  const plan = planUsageAttribution(db, ev);
  expect(plan.entries.map((e) => [e.sourceId, e.via]).sort()).toEqual([[CHILD, "parent:1"], [GRANDCHILD, "parent:2"], [GROK, "git_root_dir"]].sort());
  expect(plan.unresolved.map((u) => u.reason).sort()).toEqual(["no-git-root", "no-parent"]);

  expect(applyUsageAttribution(db, plan, 1)).toEqual({ updated: 3, skipped: 0 });
  const after = repoBySource(db);
  expect(after[CHILD]).toEqual(["game_web", S.id]);
  expect(after[GRANDCHILD]).toEqual(["game_web", S.id]);
  expect(after[GROK]).toEqual(["game_web", S.id]);
  expect(after[ORPHAN]).toEqual([null, null]);
  // The hourly rollup is recomputed by a trigger — Stats reads from it.
  expect(db.query(`SELECT SUM(sum) s FROM metrics_hourly WHERE a_repo = 'game_web'`).get()).toEqual({ s: 400 });

  // Running it again duplicates nothing.
  expect(applyUsageAttribution(db, planUsageAttribution(db, ev))).toEqual({ updated: 0, skipped: 0 });
});

test("parent attributed only via notify_log, session with a single repo", () => {
  const db = openDb(":memory:");
  insertMetrics(db, [row("01a99999-0000-0000-0000-000000000000", "codex", S), row(CHILD)]);
  insertNotifyLog(db, { ts: 1, session_id: S.id, event: "hook", decision: "none", reason: null, inflight: 0, teammates: 0, agent_session_id: PARENT, detail: null });
  const plan = planUsageAttribution(db, { codexParents: { [CHILD]: PARENT }, grokSessions: {} });
  expect(plan.entries).toMatchObject([{ sourceId: CHILD, via: "parent:1:notify", target: { session: S.id, repo: "game_web" } }]);
});

test("undo restores the rows and the rollup to the original state", () => {
  const db = fixture();
  const before = db.query("SELECT id, attrs, session_id, a_project, a_repo FROM metrics ORDER BY id").all();
  const rollupBefore = db.query("SELECT * FROM metrics_hourly ORDER BY 1,2,3,4,5,6,7").all();
  applyUsageAttribution(db, planUsageAttribution(db, ev));
  expect(undoUsageAttribution(db)).toBe(3);
  expect(db.query("SELECT id, attrs, session_id, a_project, a_repo FROM metrics ORDER BY id").all()).toEqual(before);
  expect(db.query("SELECT * FROM metrics_hourly ORDER BY 1,2,3,4,5,6,7").all()).toEqual(rollupBefore);
});
