import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type SessionRow } from "../src/db";
import {
  continueMode, continuePlan, ENDED_RETENTION_MS, getEnded, HANDOFF_TRANSCRIPT, handoffPrompt, handoffTranscript, hideEnded, listEnded,
  openTranscript, purgeEnded, recordEnded, renderTranscript, TranscriptGone,
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
    transcript: "complete", keptWorktree: null,
  });
  expect(listEnded(db)).toEqual([e]);
  expect(getEnded(db, e.id)?.native_thread).toBe("0b1c2d3e-0000-4000-8000-000000000001");
});

test("recordEnded takes a tmux session's mirror store, says when it was cut short, and lists a tmux session without one as missing", () => {
  const root = tmp();
  const db = openDb(":memory:");
  const dir = join(root, "_chat-archive", "dev-acme-app-20261120-101500");
  archivedStore(dir, "dev-acme-app.mirror.sqlite", CONVO);
  expect(recordEnded(db, { ...S, runtime: "tmux" }, dir, 5_000, { truncated: true })).toMatchObject({ runtime: "tmux", transcript: "truncated" });
  // A chat that never opened a store is no ended session worth listing.
  const empty = join(root, "_chat-archive", "dev-acme-other-20261120-101500");
  mkdirSync(empty, { recursive: true });
  writeFileSync(join(empty, "abc.jsonl"), "{}\n");
  expect(recordEnded(db, { ...S, id: "dev-acme-other" }, empty, 5_000)).toBeNull();
  // A tmux session whose Chat view was never read: its owner still sees it ended, without a transcript.
  const never = recordEnded(db, { ...S, id: "dev-acme-tui", runtime: "tmux" }, null, 6_000, { id: "dev-acme-tui-20261120-101600" })!;
  expect(never).toMatchObject({ id: "dev-acme-tui-20261120-101600", transcript: "missing", topic: null, continueMode: "handoff" });
  expect(() => openTranscript(getEnded(db, never.id)!)).toThrow(TranscriptGone);
  expect(listEnded(db).map((e) => e.id)).toEqual(["dev-acme-tui-20261120-101600", "dev-acme-app-20261120-101500"]);
});

test("an archived store is read read-only: no WAL switch, no write, after end() sealed it once", () => {
  const root = tmp();
  const db = openDb(":memory:");
  const dir = join(root, "_chat-archive", "dev-acme-app-20261120-101500");
  archivedStore(dir, "dev-acme-app.sqlite", CONVO);
  recordEnded(db, S, dir, 5_000);
  const file = join(dir, "dev-acme-app.sqlite");
  const before = statSync(file).mtimeMs;
  chmodSync(file, 0o444);
  const store = openTranscript(getEnded(db, "dev-acme-app-20261120-101500")!);
  expect(store.snapshot().items.length).toBe(2);
  store.close();
  expect(existsSync(`${file}-wal`)).toBe(false);
  expect(statSync(file).mtimeMs).toBe(before);
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

test("purge takes only what keeping transcripts added: the row, a mirror store, the images; the chat archive stays forever", () => {
  const root = tmp();
  const db = openDb(":memory:");
  const chat = join(root, "_chat-archive", "dev-acme-app-20261001-101500");
  archivedStore(chat, "dev-acme-app.sqlite", CONVO);
  writeFileSync(join(chat, "abc.jsonl"), "{}\n");
  mkdirSync(join(chat, "images"));
  writeFileSync(join(chat, "images", "x.png"), "png");
  const tui = join(root, "_chat-archive", "dev-acme-tui-20261001-101500");
  archivedStore(tui, "dev-acme-tui.mirror.sqlite", CONVO);
  const fresh = join(root, "_chat-archive", "dev-acme-app-20261120-101500");
  archivedStore(fresh, "dev-acme-app.sqlite", CONVO);
  recordEnded(db, S, chat, 1_000);
  recordEnded(db, { ...S, id: "dev-acme-tui", runtime: "tmux" }, tui, 1_000);
  recordEnded(db, S, fresh, 1_000 + ENDED_RETENTION_MS);
  const logs: string[] = [];
  expect(purgeEnded(db, 1_001 + ENDED_RETENTION_MS, (m) => logs.push(m)).sort()).toEqual(["dev-acme-app-20261001-101500", "dev-acme-tui-20261001-101500"]);
  // The chat archive as it was kept before this feature: the thread store and the Claude jsonl.
  expect(existsSync(join(chat, "dev-acme-app.sqlite"))).toBe(true);
  expect(existsSync(join(chat, "abc.jsonl"))).toBe(true);
  // The images end() used to delete: kept for the transcript, purged with it.
  expect(existsSync(join(chat, "images"))).toBe(false);
  // The mirror copy only this feature made.
  expect(existsSync(join(tui, "dev-acme-tui.mirror.sqlite"))).toBe(false);
  expect(getEnded(db, "dev-acme-app-20261001-101500")).toBeNull();
  expect(getEnded(db, "dev-acme-app-20261120-101500")).not.toBeNull();
  expect(logs).toEqual([]);
});

test("a purge that cannot remove a mirror store logs it and keeps the row for the next run", () => {
  const root = tmp();
  const db = openDb(":memory:");
  const dir = join(root, "_chat-archive", "dev-acme-tui-20261001-101500");
  archivedStore(dir, "dev-acme-tui.mirror.sqlite", CONVO);
  recordEnded(db, { ...S, id: "dev-acme-tui", runtime: "tmux" }, dir, 1_000);
  const logs: string[] = [];
  const failing = () => { throw new Error("EACCES"); };
  expect(purgeEnded(db, 2_000 + ENDED_RETENTION_MS, (m) => logs.push(m), failing)).toEqual([]);
  expect(logs.length).toBe(1);
  expect(logs[0]).toContain("dev-acme-tui-20261001-101500");
  expect(getEnded(db, "dev-acme-tui-20261001-101500")).not.toBeNull();
});

test("the handoff renders the whole transcript for the new session alone, and the prompt points at its own copy", () => {
  const root = tmp();
  const db = openDb(":memory:");
  const dir = join(root, "_chat-archive", "dev-acme-app-20261120-101500");
  archivedStore(dir, "dev-acme-app.sqlite", CONVO);
  const row = getEnded(db, recordEnded(db, { ...S, name: "Login fix" }, dir, 5_000)!.id)!;
  const md = handoffTranscript(row);
  expect(md).toContain("Fix the login form validation");
  expect(md).toContain("the email check now trims spaces");
  // Nothing lands in the shared /inbox every container mounts.
  expect(existsSync(join(root, "_inbox"))).toBe(false);
  expect(HANDOFF_TRANSCRIPT).toBe("/run/devd/ended-transcript.md");
  const prompt = handoffPrompt(row);
  expect(prompt).toContain(HANDOFF_TRANSCRIPT);
  expect(prompt).toContain("Login fix");
  expect(prompt).toContain("Fix the login form validation");
  // A terminal session's first prompt must be more than one word, and every prompt stays under the first-prompt cap.
  expect(/\s/.test(prompt)).toBe(true);
  expect(handoffPrompt(row, "the image is old")).toStartWith("(The earlier conversation could not be resumed: the image is old.");
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

test("continue resumes a Claude conversation whose jsonl the archive kept, and hands off otherwise, saying why", async () => {
  const root = tmp();
  const db = openDb(":memory:");
  const dir = join(root, "_chat-archive", "dev-acme-app-20261120-101500");
  archivedStore(dir, "dev-acme-app.sqlite", CONVO);
  const row = getEnded(db, recordEnded(db, S, dir, 5_000)!.id)!;
  // No jsonl in the archive: nothing to resume.
  expect(continueMode(row)).toBe("handoff");
  expect(await continuePlan(row, null)).toEqual({ mode: "handoff", reason: expect.stringContaining("not in the archive") });
  writeFileSync(join(dir, `${THREAD}.jsonl`), '{"type":"user"}\n');
  expect(continueMode(row)).toBe("resume");
  expect(await continuePlan(row, null)).toEqual({ mode: "resume", thread: THREAD, jsonl: Buffer.from('{"type":"user"}\n') });
  // An image that cannot resume yet: handoff, and the reason says so.
  expect(await continuePlan(row, "the session image predates resume")).toEqual({ mode: "handoff", reason: "the session image predates resume" });
  // Another agent now, or a Codex thread: resume is not wired for it, which is no failure to report.
  expect(continueMode({ ...row, agent: "codex" })).toBe("handoff");
  expect(await continuePlan({ ...row, native_harness: "codex" }, null)).toEqual({ mode: "handoff", reason: null });
  expect(await continuePlan({ ...row, native_thread: null }, null)).toEqual({ mode: "handoff", reason: null });
});

test("continue never reads a planted link as the conversation, and never a thread id that is a path", async () => {
  const root = tmp();
  const db = openDb(":memory:");
  const dir = join(root, "_chat-archive", "dev-acme-app-20261120-101500");
  archivedStore(dir, "dev-acme-app.sqlite", CONVO);
  const row = getEnded(db, recordEnded(db, S, dir, 5_000)!.id)!;
  const secret = join(root, "secret");
  writeFileSync(secret, "host secret");
  symlinkSync(secret, join(dir, `${THREAD}.jsonl`));
  expect(continueMode(row)).toBe("handoff");
  expect(await continuePlan(row, null)).toMatchObject({ mode: "handoff", reason: expect.stringContaining("could not be read") });
  expect(await continuePlan({ ...row, native_thread: "../secret" }, null)).toEqual({ mode: "handoff", reason: null });
});
