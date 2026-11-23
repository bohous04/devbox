import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveChats } from "../src/chatArchive";

// The user returns to old conversations: end() used to rmSync the session's Claude
// transcripts together with the worktree. They are now kept under _chat-archive.
test("archiveChats moves the transcripts into _chat-archive/<id>-<stamp>", () => {
  const root = mkdtempSync(join(tmpdir(), "chats-"));
  const src = join(root, "_claude-projects", "dev-a-b-2");
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, "x.jsonl"), "{}\n");
  const dest = archiveChats(root, "dev-a-b-2", new Date("2026-11-17T12:30:05Z"));
  expect(dest).toBe(join(root, "_chat-archive", "dev-a-b-2-20261117-123005"));
  expect(readFileSync(join(dest!, "x.jsonl"), "utf8")).toBe("{}\n");
  expect(existsSync(src)).toBe(false);
});

test("archiveChats drops an empty or missing directory instead of archiving it", () => {
  const root = mkdtempSync(join(tmpdir(), "chats-"));
  expect(archiveChats(root, "dev-none", new Date())).toBeNull();
  mkdirSync(join(root, "_claude-projects", "dev-empty"), { recursive: true });
  expect(archiveChats(root, "dev-empty", new Date())).toBeNull();
  expect(existsSync(join(root, "_claude-projects", "dev-empty"))).toBe(false);
  expect(existsSync(join(root, "_chat-archive"))).toBe(false);
});

test("archiveChats moves the thread store (with -wal/-shm) next to the transcripts", () => {
  const root = mkdtempSync(join(tmpdir(), "chats-"));
  const src = join(root, "_claude-projects", "dev-t");
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, "x.jsonl"), "{}\n");
  mkdirSync(join(root, "_threads"));
  for (const x of ["", "-wal"]) writeFileSync(join(root, "_threads", `dev-t.sqlite${x}`), "db" + x);
  const dest = archiveChats(root, "dev-t", new Date("2026-11-17T12:30:05Z"))!;
  expect(readFileSync(join(dest, "dev-t.sqlite"), "utf8")).toBe("db");
  expect(readFileSync(join(dest, "dev-t.sqlite-wal"), "utf8")).toBe("db-wal");
  expect(existsSync(join(dest, "dev-t.sqlite-shm"))).toBe(false);
  expect(existsSync(join(root, "_threads", "dev-t.sqlite"))).toBe(false);
});

test("archiveChats archives a thread store even when there are no transcripts", () => {
  const root = mkdtempSync(join(tmpdir(), "chats-"));
  mkdirSync(join(root, "_threads"));
  writeFileSync(join(root, "_threads", "dev-u.sqlite"), "db");
  const dest = archiveChats(root, "dev-u", new Date("2026-11-17T12:30:05Z"))!;
  expect(readFileSync(join(dest, "dev-u.sqlite"), "utf8")).toBe("db");
});

test("archiveChats creates nothing when there is nothing to move", () => {
  const root = mkdtempSync(join(tmpdir(), "chats-"));
  mkdirSync(join(root, "_threads"));
  expect(archiveChats(root, "dev-v", new Date())).toBeNull();
  expect(existsSync(join(root, "_chat-archive"))).toBe(false);
});

// One rename of the whole directory: a failure midway can never split a session's transcripts in two places.
test("archiveChats moves the transcript directory in one rename (same inode), thread files after it", () => {
  const root = mkdtempSync(join(tmpdir(), "chats-"));
  const src = join(root, "_claude-projects", "dev-a-b-3");
  mkdirSync(join(src, "sub"), { recursive: true });
  writeFileSync(join(src, "x.jsonl"), "{}\n");
  mkdirSync(join(root, "_threads"));
  writeFileSync(join(root, "_threads", "dev-a-b-3.sqlite"), "db");
  const ino = statSync(src).ino;
  const dest = archiveChats(root, "dev-a-b-3", new Date("2026-11-17T12:30:05Z"))!;
  expect(statSync(dest).ino).toBe(ino);
  expect(readFileSync(join(dest, "dev-a-b-3.sqlite"), "utf8")).toBe("db");
  expect(existsSync(join(dest, "sub"))).toBe(true);
});

// An ended tmux session keeps its Chat-view mirror as its transcript (endedSessions.ts), under a name of its own.
test("archiveChats moves a tmux session's mirror store as <id>.mirror.sqlite", () => {
  const root = mkdtempSync(join(tmpdir(), "chats-"));
  const src = join(root, "_claude-projects", "dev-m");
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, "x.jsonl"), "{}\n");
  mkdirSync(join(root, "_mirrors"));
  for (const x of ["", "-wal"]) writeFileSync(join(root, "_mirrors", `dev-m.sqlite${x}`), "m" + x);
  const dest = archiveChats(root, "dev-m", new Date("2026-11-17T12:30:05Z"))!;
  expect(readFileSync(join(dest, "dev-m.mirror.sqlite"), "utf8")).toBe("m");
  expect(readFileSync(join(dest, "dev-m.mirror.sqlite-wal"), "utf8")).toBe("m-wal");
  expect(existsSync(join(root, "_mirrors", "dev-m.sqlite"))).toBe(false);
});

test("archiveChats archives a mirror store alone", () => {
  const root = mkdtempSync(join(tmpdir(), "chats-"));
  mkdirSync(join(root, "_mirrors"));
  writeFileSync(join(root, "_mirrors", "dev-n.sqlite"), "m");
  const dest = archiveChats(root, "dev-n", new Date("2026-11-17T12:30:05Z"))!;
  expect(readFileSync(join(dest, "dev-n.mirror.sqlite"), "utf8")).toBe("m");
});
