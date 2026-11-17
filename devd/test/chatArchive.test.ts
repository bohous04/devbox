import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
