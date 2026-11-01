import { expect, test } from "bun:test";
import { groupByTurn, promptExcerpt } from "./notificationsView";
import type { NotifyLogRow } from "./api";

function row(over: Partial<NotifyLogRow> = {}): NotifyLogRow {
  return {
    id: 1, ts: 1_000, session_id: "dev-a", event: "stop", decision: "armed", reason: null,
    inflight: 0, teammates: 0, agent_session_id: null, detail: null,
    verdict: null, verdict_note: null, verdict_at: null, ...over,
  };
}

test("a prompt starts a new group and becomes its header", () => {
  const g = groupByTurn([
    row({ id: 3, event: "stop" }),
    row({ id: 2, event: "subagent_start" }),
    row({ id: 1, event: "user_prompt_submit", detail: JSON.stringify({ prompt: "do X" }) }),
  ]);
  expect(g).toHaveLength(1);
  // rows deliberately does NOT contain the header (prompt) row — the page appends it to rows
  // itself (`[...g.rows, ...(g.header ? [g.header] : [])]`), so returning it in rows too would
  // render it twice on the page.
  expect(g[0].rows.map((r) => r.id)).toEqual([3, 2]);
  expect(g[0].header!.id).toBe(1);
  expect(g[0].rows.some((r) => r.id === 1)).toBe(false);
  expect(promptExcerpt(g[0].header!)).toBe("do X");
});

test("two prompts = two groups", () => {
  const g = groupByTurn([
    row({ id: 4, event: "stop" }),
    row({ id: 3, event: "user_prompt_submit" }),
    row({ id: 2, event: "stop" }),
    row({ id: 1, event: "user_prompt_submit" }),
  ]);
  expect(g).toHaveLength(2);
});

test("a session change ends the group, even without a prompt", () => {
  const g = groupByTurn([
    row({ id: 3, session_id: "dev-b", event: "stop" }),
    row({ id: 2, session_id: "dev-a", event: "stop" }),
    row({ id: 1, session_id: "dev-a", event: "user_prompt_submit" }),
  ]);
  expect(g).toHaveLength(2);
  expect(g[0].rows.every((r) => r.session_id === "dev-b")).toBe(true);
  expect(g[1].rows.every((r) => r.session_id === "dev-a")).toBe(true);
});

test("rows without a prompt form a group without a header", () => {
  const g = groupByTurn([row({ id: 2, event: "stop" }), row({ id: 1, event: "subagent_stop" })]);
  expect(g).toHaveLength(1);
  expect(g[0].header).toBeNull();
});

test("empty input gives empty output", () => {
  expect(groupByTurn([])).toEqual([]);
});

test("promptExcerpt returns null when the detail carries no prompt or is broken", () => {
  expect(promptExcerpt(row({ detail: null }))).toBeNull();
  expect(promptExcerpt(row({ detail: "{invalid" }))).toBeNull();
  expect(promptExcerpt(row({ detail: JSON.stringify({ agentType: "Explore" }) }))).toBeNull();
});
