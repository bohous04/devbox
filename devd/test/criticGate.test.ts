import { expect, test } from "bun:test";
import { insertSession, listCriticReviews, listEvents, openDb, setCritic, type SessionRow } from "../src/db";
import { DEFAULT_CRITIC_CFG } from "../src/criticProvider";
import { createCriticGate, type CriticDeps } from "../src/criticGate";

const ROW: SessionRow = {
  id: "dev-shop-cms", folder: "acme", project: "shop", repo: "cms", container: "dev-shop-cms",
  port_base: 40100, status: "running", solo: 0, created_at: 0, last_active_at: 0, important: 0,
};

function fixture(over: Partial<CriticDeps> = {}, criticOn = true) {
  const db = openDb(":memory:");
  insertSession(db, ROW);
  if (criticOn) setCritic(db, ROW.id, 1);
  const calls: string[] = [];
  let t = 1000;
  const gate = createCriticGate({
    db,
    head: async () => "abc123",
    diff: async () => ({ diff: "--- a\n+++ b\n+change", newFiles: [], truncated: [] }),
    run: async (_s, prompt) => { calls.push(prompt); return JSON.stringify({ result: '{"verdict":"ok","findings":[]}' }); },
    cfg: () => DEFAULT_CRITIC_CFG,
    now: () => (t += 10),
    uuid: () => "turn-1",
    ...over,
  });
  const row = () => ({ ...ROW, critic: (criticOn ? 1 : 0) as 0 | 1 });
  return { db, gate, calls, row };
}

test("critic off → no review, no block", async () => {
  const { db, gate, calls, row } = fixture({}, false);
  gate.onPrompt(row(), "do X");
  expect(await gate.onStop(row())).toEqual({ block: false });
  expect(calls).toHaveLength(0);
  expect(listCriticReviews(db, ROW.id)).toHaveLength(0);
});

test("clean verdict → lets through, records the review and critic_pass", async () => {
  const { db, gate, row } = fixture();
  gate.onPrompt(row(), "do X");
  expect(await gate.onStop(row())).toEqual({ block: false });
  const reviews = listCriticReviews(db, ROW.id);
  expect(reviews).toHaveLength(1);
  expect(reviews[0].verdict).toBe("ok");
  expect(reviews[0].round).toBe(1);
  expect(listEvents(db, { type: "critic_pass" })).toHaveLength(1);
});

test("findings in round 1 block, round 2 lets through and logs critic_giveup", async () => {
  const issues = JSON.stringify({
    result: '{"verdict":"issues","findings":[{"severity":"critical","file":"a.ts","line":2,"what":"broken migration"}]}',
  });
  const { db, gate, row } = fixture({ run: async () => issues });
  gate.onPrompt(row(), "do X");
  const first = await gate.onStop(row());
  expect(first.block).toBe(true);
  if (first.block) expect(first.reason).toContain("broken migration");
  const second = await gate.onStop(row());
  expect(second).toEqual({ block: false });          // round limit exhausted
  expect(listEvents(db, { type: "critic_block" })).toHaveLength(1);
  expect(listEvents(db, { type: "critic_giveup" })).toHaveLength(1);
  expect(listCriticReviews(db, ROW.id)).toHaveLength(2);
});

test("a new prompt resets the round counter", async () => {
  const issues = JSON.stringify({ result: '{"verdict":"issues","findings":[{"severity":"important","what":"bug"}]}' });
  const { gate, row } = fixture({ run: async () => issues, uuid: (() => { let n = 0; return () => `turn-${++n}`; })() });
  gate.onPrompt(row(), "first");
  expect((await gate.onStop(row())).block).toBe(true);
  expect((await gate.onStop(row())).block).toBe(false);   // exhausted
  gate.onPrompt(row(), "second");                         // new turn
  expect((await gate.onStop(row())).block).toBe(true);    // from the start again
});

test("only minor findings do not block", async () => {
  const minor = JSON.stringify({ result: '{"verdict":"issues","findings":[{"severity":"minor","what":"variable name"}]}' });
  const { db, gate, row } = fixture({ run: async () => minor });
  gate.onPrompt(row(), "do X");
  expect(await gate.onStop(row())).toEqual({ block: false });
  expect(listEvents(db, { type: "critic_pass" })).toHaveLength(1);
});

test("empty diff → the critic does not run at all", async () => {
  const { db, gate, calls, row } = fixture({ diff: async () => ({ diff: "", newFiles: [], truncated: [] }) });
  gate.onPrompt(row(), "just a question");
  expect(await gate.onStop(row())).toEqual({ block: false });
  expect(calls).toHaveLength(0);
  expect(listCriticReviews(db, ROW.id)).toHaveLength(0);
});

test("fail-open: a crashed critic, unreadable output and a diff error all let the turn through", async () => {
  for (const broken of [
    { run: async () => { throw new Error("docker exec failed"); } },
    { run: async () => "the model chatted and returned nothing" },
    { diff: async () => { throw new Error("git crashed"); } },
  ] as Partial<CriticDeps>[]) {
    const { db, gate, row } = fixture(broken);
    gate.onPrompt(row(), "do X");
    expect(await gate.onStop(row())).toEqual({ block: false });
    expect(listEvents(db, { type: "critic_error" })).toHaveLength(1);
  }
});

test("onStop without a preceding prompt (devd restart mid-turn) does not crash", async () => {
  const { gate, row } = fixture();
  expect(await gate.onStop(row())).toEqual({ block: false });
});
