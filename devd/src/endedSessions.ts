// Ended sessions as read-only transcripts. end() (sessions.ts) archives the session's chat thread or tmux mirror
// store into `_chat-archive/<id>-<stamp>` (chatArchive.ts) with its images; recordEnded lists it here. The inbox shows
// it in Settled until it is hidden or purged, 30 days after the end. Continuing one opens a new session in the same
// repo (api.ts, POST /api/ended/:id/continue).
import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ContinueMode, EndedSession } from "../../shared/ended";
import type { ThreadItem } from "../../shared/thread";
import { threadTitle } from "../../shared/threadTitle";
import type { SessionRow } from "./db";
import { ThreadStore } from "./threadStore";

export const ENDED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const ENDED_PURGE_TICK_MS = 60 * 60 * 1000;
/** Same clip as the inbox's lastText (sessionInbox.ts LAST_TEXT_MAX). */
const LAST_TEXT_MAX = 200;

export interface EndedRow {
  id: string; session_id: string; folder: string; project: string; repo: string; agent: string; runtime: "tmux" | "chat";
  title: string; branch: string | null; topic: string | null; last_text: string | null; ended_at: number;
  archive_dir: string; store_file: string; native_harness: string | null; native_thread: string | null; hidden_at: number | null;
}

const clip = (t: string, max: number) => (t.length > max ? `${t.slice(0, max)}…` : t);

/** What continue does for this transcript. No path starts a new session on an old native conversation yet, so every
 *  transcript continues by handoff; the resume handle (native_harness/native_thread) is recorded for when one does. */
export function continueMode(_row: EndedRow): ContinueMode {
  return "handoff";
}

export function toEnded(r: EndedRow): EndedSession {
  return {
    id: r.id, sessionId: r.session_id, runtime: r.runtime, title: r.title, folder: r.folder, project: r.project, repo: r.repo,
    agent: r.agent, branch: r.branch, topic: r.topic, lastText: r.last_text, endedAt: r.ended_at, continueMode: continueMode(r),
  };
}

/** The store archiveChats moved into `archiveDir`: a chat thread (`<id>.sqlite`) or a tmux mirror (`<id>.mirror.sqlite`). */
function archivedStoreFile(archiveDir: string, sessionId: string): string | null {
  for (const name of [`${sessionId}.sqlite`, `${sessionId}.mirror.sqlite`]) if (existsSync(join(archiveDir, name))) return name;
  return null;
}

/** Lists the ended session whose store end() archived into `archiveDir`; null when it left no store (a tmux session
 *  whose transcript was never mirrored, an InstaBox session). Throws when the archived store cannot be read. */
export function recordEnded(db: Database, s: SessionRow, archiveDir: string, endedAt: number): EndedSession | null {
  const file = archivedStoreFile(archiveDir, s.id);
  if (file === null) return null;
  const store = ThreadStore.openFile(join(archiveDir, file));
  let first: string | null, last: string | null, native: { harness: string; nativeThreadId: string } | null;
  try {
    first = store.firstUserText();
    last = store.lastMessageText();
    native = store.snapshot({ limit: 0 }).native;
  } finally { store.close(); }
  const row: EndedRow = {
    id: archiveDir.slice(archiveDir.lastIndexOf("/") + 1), session_id: s.id, folder: s.folder, project: s.project, repo: s.repo,
    // `agent` is optional in SessionRow only for insert literals; the column is NOT NULL.
    agent: s.agent!, runtime: s.runtime === "chat" ? "chat" : "tmux", title: s.name || `${s.project}/${s.repo}`, branch: s.branch ?? null,
    topic: first === null ? null : threadTitle(first), last_text: last === null ? null : clip(last, LAST_TEXT_MAX), ended_at: endedAt,
    archive_dir: archiveDir, store_file: file, native_harness: native?.harness ?? null, native_thread: native?.nativeThreadId ?? null, hidden_at: null,
  };
  db.query(`INSERT OR REPLACE INTO ended_sessions (id,session_id,folder,project,repo,agent,runtime,title,branch,topic,last_text,ended_at,archive_dir,store_file,native_harness,native_thread,hidden_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)`).run(row.id, row.session_id, row.folder, row.project, row.repo, row.agent, row.runtime, row.title,
    row.branch, row.topic, row.last_text, row.ended_at, row.archive_dir, row.store_file, row.native_harness, row.native_thread);
  return toEnded(row);
}

/** Visible transcripts, newest first. */
export function listEnded(db: Database): EndedSession[] {
  return (db.query(`SELECT * FROM ended_sessions WHERE hidden_at IS NULL ORDER BY ended_at DESC, id`).all() as EndedRow[]).map(toEnded);
}

export function getEnded(db: Database, id: string): EndedRow | null {
  return (db.query(`SELECT * FROM ended_sessions WHERE id=?`).get(id) as EndedRow | null) ?? null;
}

/** Hides a transcript from the inbox (it is still purged on schedule). Returns whether there was one to hide. */
export function hideEnded(db: Database, id: string, now: number): boolean {
  return db.query(`UPDATE ended_sessions SET hidden_at=? WHERE id=? AND hidden_at IS NULL`).run(now, id).changes > 0;
}

/** The archived store, opened for reading its snapshot. The caller closes it. */
export function openTranscript(row: EndedRow): ThreadStore {
  const path = join(row.archive_dir, row.store_file);
  // openFile would create an empty store in place of a missing one.
  if (!existsSync(path)) throw new Error(`the transcript of ${row.id} is missing: ${path}`);
  return ThreadStore.openFile(path);
}

/** The archived images of an ended session (archiveThreadImages). */
export const endedImagesDir = (row: EndedRow) => join(row.archive_dir, "images");

/** `<root>/_inbox/_ended/<id>.md`, which every container sees as `/inbox/_ended/<id>.md` (read-only, like the images). */
export const endedTranscriptFile = (root: string, id: string) => join(root, "_inbox", "_ended", `${id}.md`);

/** Removes transcripts that ended more than 30 days ago: the store, its images and a handoff copy. The Claude jsonl
 *  transcripts next to them stay, as they did before transcripts were kept. A failed removal is logged and the row
 *  stays for the next run. Returns the purged ids. */
export function purgeEnded(db: Database, root: string, now: number, log: (msg: string) => void,
  remove: (path: string) => void = (p) => rmSync(p, { recursive: true, force: true })): string[] {
  const due = db.query(`SELECT * FROM ended_sessions WHERE ended_at < ?`).all(now - ENDED_RETENTION_MS) as EndedRow[];
  const purged: string[] = [];
  for (const r of due) {
    try {
      for (const x of ["", "-wal", "-shm"]) remove(join(r.archive_dir, `${r.store_file}${x}`));
      remove(endedImagesDir(r));
      remove(endedTranscriptFile(root, r.id));
    } catch (e) {
      log(`ended transcripts: purging ${r.id} failed, retried on the next run: ${(e as Error).message}`);
      continue;
    }
    db.query(`DELETE FROM ended_sessions WHERE id=?`).run(r.id);
    purged.push(r.id);
  }
  return purged;
}

function toolLine(it: ThreadItem): string {
  const input = it.input as Record<string, unknown> | string | undefined;
  const detail = typeof input === "string" ? input
    : typeof input?.command === "string" ? input.command
    : typeof input?.file_path === "string" ? input.file_path : null;
  return `- \`${it.tool}\`${detail === null ? "" : `: ${detail}`}${it.isError ? " (failed)" : ""}`;
}

/** The transcript as Markdown for the next agent: messages in full, tool calls as one line each. */
export function renderTranscript(meta: { title: string; project: string; repo: string }, snap: { items: ThreadItem[] }): string {
  const out = [`# ${meta.title} (${meta.project}/${meta.repo})`, ""];
  for (const it of snap.items) {
    if (it.kind === "user" || it.kind === "assistant") {
      out.push(`## ${it.kind === "user" ? "User" : "Assistant"}`, "", it.text);
      if (it.attachments?.length) out.push("", `Images: ${it.attachments.join(", ")}`);
      out.push("");
    } else if (it.kind === "tool" && it.tool !== undefined) out.push(toolLine(it), "");
  }
  return out.join("\n");
}

/** Writes the whole transcript where the new session's container reads it. Returns both paths. */
export function writeHandoffTranscript(root: string, row: EndedRow): { host: string; container: string } {
  const store = openTranscript(row);
  let md: string;
  try { md = renderTranscript(row, store.snapshot()); } finally { store.close(); }
  const host = endedTranscriptFile(root, row.id);
  mkdirSync(join(root, "_inbox", "_ended"), { recursive: true });
  writeFileSync(host, md);
  return { host, container: `/inbox/_ended/${row.id}.md` };
}

/** The new session's first message: what the ended session was about, its last message and where the rest is. */
export function handoffPrompt(row: EndedRow, transcriptPath: string): string {
  // What reaches the agent is devd's own text; the quoted parts came from the agent and may carry control characters.
  // eslint-disable-next-line no-control-regex -- the point of the replace
  const plain = (t: string) => t.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, " ");
  const where = `${row.project}/${row.repo}${row.branch ? `, branch ${row.branch}` : ""}`;
  return [
    `This session continues an earlier one that has ended: "${plain(row.title)}" (${where}).`,
    ...(row.topic ? [`It started with: ${plain(row.topic)}`] : []),
    ...(row.last_text ? [`Its last message was: ${plain(row.last_text)}`] : []),
    `The whole earlier conversation is in ${transcriptPath} (read-only). Read it, then say in a few sentences where it left off and wait for what I want next.`,
  ].join("\n\n");
}
