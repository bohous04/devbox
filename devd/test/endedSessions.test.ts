import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type SessionRow } from "../src/db";
import {
  continueMode, continuePlan, ENDED_RETENTION_MS, endedTranscriptFile, getEnded, handoffPrompt, hideEnded, listEnded, openTranscript,
  purgeEnded, recordEnded, renderTranscript, writeHandoffTranscript,
} from "../src/endedSessions";
import { ThreadStore } from "../src/threadStore";
import type { BridgeEvent } from "../../shared/thread";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

const S: SessionRow = {
  id: "dev-acme-app", folder: "acme", project: "acme", repo: "app", container: "dev-acme-app", port_base: 40100,
  status: "running", solo: 0, created_at: 0, last_active_at: 0, important: 0, agent: "claude", runtime: "chat", branch: "feat/x",
};

function tmp() {
  const root = mkdtempSync(join(tmpdir(), "ended-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

/** An archived store as archiveChats leaves it: `<dir>/<file>` with a short conversation. */
function archivedStore(dir: string, file: string, events: BridgeEvent[]) {
  mkdirSync(dir, { recursive: true });
  const tmpRoot = tmp();
  const store = ThreadStore.open(tmpRoot, "x");
  events.forEach((event, i) => store.apply({ seq: i + 1, ts: 1000 * (i + 1), event }));
  store.close();
  for (const x of ["", "-wal", "-shm"]) {
    const from = join(tmpRoot, "_threads", `x.sqlite${x}`);
    if (existsSync(from)) writeFileSync(join(dir, `${file}${x}`), readFileSync(from));
  }
}

const CONVO: BridgeEvent[] = [
  { type: "thread.native", harness: "claude", nativeThreadId: "0b1c2d3e-0000-4000-8000-000000000001", account: null, model: null },
  { type: "run.started", runId: "r1", origin: "user", nativeThreadId: null, model: null },
  { type: "message.final", runId: "r1", itemId: "u1", role: "user", text: "Fix the login form validation" },
  { type: "message.final", runId: "r1", itemId: "a1", role: "assistant", text: "Fixed it; the email check now trims spaces." },
  { type: "run.completed", runId: "r1", nativeThreadId: "0b1c2d3e-0000-4000-8000-000000000001", usage: null, costUsd: null },
];

test("recordEnded keeps a chat session's archived thread as an ended transcript", () => {
  const root = tmp();
  const db = openDb(":memory:");
  const dir = join(root, "_chat-archive", "dev-acme-app-20261120-101500");
  archivedStore(dir, "dev-acme-app.sqlite", CONVO);
  const e = recordEnded(db, { ...S, name: "Login fix" }, dir, 5_000)!;
  expect(e).toEqual({
    id: "dev-acme-app-20261120-101500", sessionId: "dev-acme-app", runtime: "chat", title: "Login fix",
    folder: "acme", project: "acme", repo: "app", agent: "claude", branch: "feat/x",
    topic: "Fix the login form validation", lastText: "Fixed it; the email check now trims spaces.", endedAt: 5_000, continueMode: "handoff",
  });
  expect(listEnded(db)).toEqual([e]);
  expect(getEnded(db, e.id)?.native_thread).toBe("0b1c2d3e-0000-4000-8000-000000000001");
});

test("recordEnded takes a tmux session's mirror store, and records nothing without a store", () => {
  const root = tmp();
  const db = openDb(":memory:");
  const dir = join(root, "_chat-archive", "dev-acme-app-20261120-101500");
  archivedStore(dir, "dev-acme-app.mirror.sqlite", CONVO);
  expect(recordEnded(db, { ...S, runtime: "tmux" }, dir, 5_000)?.runtime).toBe("tmux");
  const empty = join(root, "_chat-archive", "dev-acme-other-20261120-101500");
  mkdirSync(empty, { recursive: true });
  writeFileSync(join(empty, "abc.jsonl"), "{}\n");
  expect(recordEnded(db, { ...S, id: "dev-acme-other" }, empty, 5_000)).toBeNull();
  expect(listEnded(db).map((e) => e.id)).toEqual(["dev-acme-app-20261120-101500"]);
});

test("listEnded is newest first and leaves hidden transcripts out; hideEnded says whether it found one", () => {
  const root = tmp();
  const db = openDb(":memory:");
  for (const [stamp, at] of [["20261120-101500", 1_000], ["20261121-101500", 2_000]] as const) {
    const dir = join(root, "_chat-archive", `dev-acme-app-${stamp}`);
    archivedStore(dir, "dev-acme-app.sqlite", CONVO);
    recordEnded(db, S, dir, at);
  }
  expect(listEnded(db).map((e) => e.endedAt)).toEqual([2_000, 1_000]);
  expect(hideEnded(db, "dev-acme-app-20261121-101500", 3_000)).toBe(true);
  expect(hideEnded(db, "nope", 3_000)).toBe(false);
  expect(listEnded(db).map((e) => e.endedAt)).toEqual([1_000]);
});

test("openTranscript serves the archived store's snapshot, the same shape as a live thread", () => {
  const root = tmp();
  const db = openDb(":memory:");
  const dir = join(root, "_chat-archive", "dev-acme-app-20261120-101500");
  archivedStore(dir, "dev-acme-app.sqlite", CONVO);
  const e = recordEnded(db, S, dir, 5_000)!;
  const store = openTranscript(getEnded(db, e.id)!);
  const snap = store.snapshot();
  store.close();
  expect(snap.items.map((i) => [i.kind, i.text])).toEqual([["user", "Fix the login form validation"], ["assistant", "Fixed it; the email check now trims spaces."]]);
  expect(snap.runs.map((r) => r.status)).toEqual(["completed"]);
});

test("purgeEnded removes transcripts older than 30 days with their images, and keeps the Claude jsonl", () => {
  const root = tmp();
  const db = openDb(":memory:");
  const old = join(root, "_chat-archive", "dev-acme-app-20261001-101500");
  archivedStore(old, "dev-acme-app.sqlite", CONVO);
  writeFileSync(join(old, "abc.jsonl"), "{}\n");
  mkdirSync(join(old, "images"));
  writeFileSync(join(old, "images", "x.png"), "png");
  const fresh = join(root, "_chat-archive", "dev-acme-app-20261120-101500");
  archivedStore(fresh, "dev-acme-app.sqlite", CONVO);
  recordEnded(db, S, old, 1_000);
  recordEnded(db, S, fresh, 1_000 + ENDED_RETENTION_MS);
  const handoff = writeHandoffTranscript(root, getEnded(db, "dev-acme-app-20261001-101500")!);
  const now = 1_001 + ENDED_RETENTION_MS;
  const logs: string[] = [];
  expect(purgeEnded(db, root, now, (m) => logs.push(m))).toEqual(["dev-acme-app-20261001-101500"]);
  expect(existsSync(join(old, "dev-acme-app.sqlite"))).toBe(false);
  expect(existsSync(join(old, "images"))).toBe(false);
  expect(existsSync(join(old, "abc.jsonl"))).toBe(true);
  expect(existsSync(handoff.host)).toBe(false);
  expect(existsSync(join(fresh, "dev-acme-app.sqlite"))).toBe(true);
  expect(getEnded(db, "dev-acme-app-20261001-101500")).toBeNull();
  expect(logs).toEqual([]);
});

test("a purge that cannot remove a transcript logs it and keeps the row for the next run", () => {
  const root = tmp();
  const db = openDb(":memory:");
  const dir = join(root, "_chat-archive", "dev-acme-app-20261001-101500");
  archivedStore(dir, "dev-acme-app.sqlite", CONVO);
  recordEnded(db, S, dir, 1_000);
  const logs: string[] = [];
  const failing = () => { throw new Error("EACCES"); };
  expect(purgeEnded(db, root, 2_000 + ENDED_RETENTION_MS, (m) => logs.push(m), failing)).toEqual([]);
  expect(logs.length).toBe(1);
  expect(logs[0]).toContain("dev-acme-app-20261001-101500");
  expect(getEnded(db, "dev-acme-app-20261001-101500")).not.toBeNull();
});

test("the handoff writes the whole transcript where the new container can read it, and the prompt points at it", () => {
  const root = tmp();
  const db = openDb(":memory:");
  const dir = join(root, "_chat-archive", "dev-acme-app-20261120-101500");
  archivedStore(dir, "dev-acme-app.sqlite", CONVO);
  const row = getEnded(db, recordEnded(db, { ...S, name: "Login fix" }, dir, 5_000)!.id)!;
  const file = writeHandoffTranscript(root, row);
  expect(file.container).toBe("/inbox/_ended/dev-acme-app-20261120-101500.md");
  expect(file.host).toBe(endedTranscriptFile(root, row.id));
  const md = readFileSync(file.host, "utf8");
  expect(md).toContain("Fix the login form validation");
  expect(md).toContain("the email check now trims spaces");
  const prompt = handoffPrompt(row, file.container);
  expect(prompt).toContain("/inbox/_ended/dev-acme-app-20261120-101500.md");
  expect(prompt).toContain("Login fix");
  expect(prompt).toContain("Fix the login form validation");
  // A terminal session's first prompt must be more than one word, and every prompt stays under the first-prompt cap.
  expect(/\s/.test(prompt)).toBe(true);
});

test("renderTranscript puts each message under who said it and names tool calls", () => {
  const md = renderTranscript({ title: "T", project: "acme", repo: "app" }, {
    items: [
      { seq: 1, runId: "r", itemId: "u", kind: "user", text: "hello there", ts: 0, attachments: ["/inbox/dev-acme-app/a.png"] },
      { seq: 2, runId: "r", itemId: "t", kind: "tool", text: "", ts: 0, tool: "Bash", input: { command: "ls -la" } },
      { seq: 3, runId: "r", itemId: "a", kind: "assistant", text: "done", ts: 0 },
    ],
  });
  expect(md).toContain("## User\n\nhello there");
  expect(md).toContain("a.png");
  expect(md).toContain("`Bash`: ls -la");
  expect(md).toContain("## Assistant\n\ndone");
});

const THREAD = "0b1c2d3e-0000-4000-8000-000000000001";

test("continue resumes a Claude conversation whose jsonl the archive kept, and hands off otherwise, saying why", () => {
  const root = tmp();
  const db = openDb(":memory:");
  const dir = join(root, "_chat-archive", "dev-acme-app-20261120-101500");
  archivedStore(dir, "dev-acme-app.sqlite", CONVO);
  const row = getEnded(db, recordEnded(db, S, dir, 5_000)!.id)!;
  // No jsonl in the archive: nothing to resume.
  expect(continueMode(row)).toBe("handoff");
  expect(continuePlan(row, null)).toEqual({ mode: "handoff", reason: expect.stringContaining("not in the archive") });
  writeFileSync(join(dir, `${THREAD}.jsonl`), '{"type":"user"}\n');
  expect(continueMode(row)).toBe("resume");
  expect(continuePlan(row, null)).toEqual({ mode: "resume", thread: THREAD, jsonl: Buffer.from('{"type":"user"}\n') });
  // An image that cannot resume yet: handoff, and the reason says so.
  expect(continuePlan(row, "the session image predates resume")).toEqual({ mode: "handoff", reason: "the session image predates resume" });
  // Another agent now, or a Codex thread: resume is not wired for it, which is no failure to report.
  expect(continueMode({ ...row, agent: "codex" })).toBe("handoff");
  expect(continuePlan({ ...row, native_harness: "codex" }, null)).toEqual({ mode: "handoff", reason: null });
  expect(continuePlan({ ...row, native_thread: null }, null)).toEqual({ mode: "handoff", reason: null });
});

test("continue never reads a planted link as the conversation, and never a thread id that is a path", () => {
  const root = tmp();
  const db = openDb(":memory:");
  const dir = join(root, "_chat-archive", "dev-acme-app-20261120-101500");
  archivedStore(dir, "dev-acme-app.sqlite", CONVO);
  const row = getEnded(db, recordEnded(db, S, dir, 5_000)!.id)!;
  const secret = join(root, "secret");
  writeFileSync(secret, "host secret");
  symlinkSync(secret, join(dir, `${THREAD}.jsonl`));
  expect(continueMode(row)).toBe("handoff");
  expect(continuePlan(row, null)).toMatchObject({ mode: "handoff", reason: expect.stringContaining("could not be read") });
  expect(continuePlan({ ...row, native_thread: "../secret" }, null)).toEqual({ mode: "handoff", reason: null });
});
