import { expect, test } from "bun:test";
import type { RunRow, ThreadItem } from "../../shared/thread";
import { ApiError, type SessionChanges } from "./api";
import { changesAnchor, changesError, changesTitle, countsIncomplete, fileStat, groupByFolder, splitPath, statusLetter } from "./changesView";

const changes = (n: number, truncated?: boolean): SessionChanges =>
  ({ base: "origin/main", files: [], totals: { files: n, added: 0, removed: 0 }, ...(truncated ? { truncated } : {}) });

test("changesTitle: count and plural from the totals", () => {
  expect(changesTitle(changes(1))).toBe("1 changed file");
  expect(changesTitle(changes(3))).toBe("3 changed files");
  expect(changesTitle(changes(200, true))).toBe("200 changed files");
});

test("fileStat, statusLetter, splitPath", () => {
  expect(fileStat({ path: "a", status: "modified", added: 12, removed: 3 })).toEqual({ added: 12, removed: 3 });
  expect(fileStat({ path: "logo.png", status: "added", added: null, removed: null })).toBe("not counted");
  expect(statusLetter("untracked")).toBe("U");
  expect(splitPath("src/sync/queue.ts")).toEqual({ dir: "src/sync/", name: "queue.ts" });
  expect(splitPath("README.md")).toEqual({ dir: "", name: "README.md" });
});

let seq = 0;
const item = (runId: string, kind: ThreadItem["kind"]): ThreadItem => ({ seq: ++seq, runId, itemId: `i${seq}`, kind, text: "", status: "done", ts: seq });
const run = (runId: string, status: RunRow["status"], endedSeq: number | null): RunRow =>
  ({ runId, origin: "user", status, harness: null, nativeThreadId: null, model: null, queuedAt: null, startedAt: 1, endedAt: endedSeq === null ? null : 2, endedSeq, usage: null, error: null });

test("changesAnchor: the latest finished run's last answer, none while a run is active", () => {
  const items = [item("a", "user"), item("a", "assistant"), item("b", "user"), item("b", "assistant"), item("b", "tool"), item("b", "assistant")];
  expect(changesAnchor(items, [run("a", "completed", 5), run("b", "completed", 9)])).toEqual({ item: items[5], endedSeq: 9 });
  expect(changesAnchor(items, [run("a", "completed", 5), run("b", "running", null)])).toBeNull();
  expect(changesAnchor(items, [run("a", "completed", 5), run("b", "queued", null)])).toBeNull();
  // A last run without an answer (interrupted before replying): no card.
  expect(changesAnchor(items.slice(0, 3), [run("a", "completed", 5), run("b", "interrupted", 7)])).toBeNull();
  expect(changesAnchor([], [])).toBeNull();
});

test("changesError: the error's message; a repository without commits (code no_commits) is no card, not an error", () => {
  expect(changesError(new ApiError("repository has no commits yet", 409, { error: "repository has no commits yet", code: "no_commits" }))).toBeNull();
  // The code decides, not the wording.
  expect(changesError(new ApiError("reworded: nothing committed", 409, { error: "reworded: nothing committed", code: "no_commits" }))).toBeNull();
  expect(changesError(new ApiError("repository has no commits yet", 409, { error: "repository has no commits yet" }))).toBe("repository has no commits yet");
  expect(changesError(new ApiError("session worktree is missing", 409, { error: "session worktree is missing", code: "worktree_missing" }))).toBe("session worktree is missing");
  expect(changesError(new ApiError("not found", 404, { error: "not found" }))).toBe("not found");
  expect(changesError(new Error("network down"))).toBe("network down");
});

test("groupByFolder: first-seen folder order, summed counts, binary adds nothing, root files apart", () => {
  const groups = groupByFolder([
    { path: "src/sync/queue.ts", status: "added", added: 58, removed: 0 },
    { path: "README.md", status: "modified", added: 1, removed: 1 },
    { path: "src/sync/replay.ts", status: "modified", added: 11, removed: 2 },
    { path: "src/sync/icon.png", status: "added", added: null, removed: null },
  ]);
  expect(groups.map((g) => [g.dir, g.added, g.removed, g.files.length])).toEqual([["src/sync/", 69, 2, 3], ["", 1, 1, 1]]);
});

test("countsIncomplete: either devd flag", () => {
  const base = { base: "origin/main", files: [], totals: { files: 0, added: 0, removed: 0 } };
  expect(countsIncomplete(base)).toBe(false);
  expect(countsIncomplete({ ...base, countsCapped: true })).toBe(true);
  expect(countsIncomplete({ ...base, countsUnavailable: true })).toBe(true);
});
