// Ended sessions as read-only transcripts. end() (sessions.ts) archives the session's chat thread or tmux mirror
// store into `_chat-archive/<id>-<stamp>` (chatArchive.ts) with its images; recordEnded lists it here. The inbox shows
// it in Settled until it is hidden or purged, 30 days after the end. Continuing one opens a new session in the same
// repo (api.ts, POST /api/ended/:id/continue).
import type { Database } from "bun:sqlite";
import { constants as C, existsSync, lstatSync, rmSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import type { ContinueMode, EndedSession, TranscriptState } from "../../shared/ended";
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
  /** "" with transcript `missing` when end() archived nothing. */
  archive_dir: string; store_file: string; native_harness: string | null; native_thread: string | null; hidden_at: number | null;
  transcript: TranscriptState;
  kept_worktree: string | null;
  /** Why no conversation was recorded (several in the session, none confirmed at the end); null otherwise. */
  thread_note: string | null;
}

const clip = (t: string, max: number) => (t.length > max ? `${t.slice(0, max)}…` : t);

const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** How continue goes on with this transcript. `resume`: Claude Code starts on the ended session's own conversation,
 *  whose jsonl `end()` archived with the transcript (chatArchive.ts); continue copies it into the new session.
 *  `handoff`: the new session's first message points at the whole transcript. `reason` says why a Claude conversation
 *  that should resume does not; it is null where resume is not wired (Codex, the other agents). */
export type ContinuePlan = { mode: "resume"; thread: string; jsonl: Buffer } | { mode: "handoff"; reason: string | null };

/** Codex continues by handoff only. Its rollout lives in the account's CODEX_HOME volume, which end() neither archives
 *  nor owns; resuming it would need that same account leased to the new session and a Codex resume path in
 *  agent-launch.sh and the bridge's first start. Claude resumes because its jsonl sits in the session's own
 *  `_claude-projects/<id>`, which archiveChats moves into the archive: resume depends on that. */
/** Why this transcript cannot resume, without reading the conversation: null when it can (as far as the archive
 *  shows); `wired: false` when resume does not exist for its agent at all. */
function resumeBlock(row: EndedRow): { wired: boolean; reason: string } | null {
  if (row.thread_note !== null && row.agent === "claude") return { wired: true, reason: row.thread_note };
  if (row.native_harness !== "claude" || row.agent !== "claude" || row.native_thread === null || !THREAD_ID.test(row.native_thread) || row.archive_dir === "") {
    return { wired: false, reason: "" };
  }
  const file = join(row.archive_dir, `${row.native_thread}.jsonl`);
  let st;
  try { st = lstatSync(file); } catch { return { wired: true, reason: `the Claude conversation ${row.native_thread} is not in the archive` }; }
  // The archive was the agent's own directory: a link there could point anywhere on the host.
  if (!st.isFile()) return { wired: true, reason: `the Claude conversation file ${row.native_thread}.jsonl could not be read: it is not a regular file` };
  return null;
}

/** What the inbox and the transcript's button say continue will do (the button names the mode). */
export function continueMode(row: EndedRow): ContinueMode {
  return resumeBlock(row) === null ? "resume" : "handoff";
}

/** The plan continue carries out. `imageBlock`: why the session image cannot take a resume (an image built before
 *  it could), null when it can. The conversation is read here, once, without following a link, off the event loop. */
export async function continuePlan(row: EndedRow, imageBlock: string | null): Promise<ContinuePlan> {
  const block = resumeBlock(row);
  if (block !== null) return { mode: "handoff", reason: block.wired ? block.reason : null };
  if (imageBlock !== null) return { mode: "handoff", reason: imageBlock };
  const thread = row.native_thread!;
  try {
    const f = await open(join(row.archive_dir, `${thread}.jsonl`), C.O_RDONLY | C.O_NOFOLLOW);
    try {
      if (!(await f.stat()).isFile()) throw new Error("not a regular file");
      return { mode: "resume", thread, jsonl: await f.readFile() };
    } finally { await f.close(); }
  } catch (e) {
    return { mode: "handoff", reason: `the Claude conversation file ${thread}.jsonl could not be read: ${(e as Error).message}` };
  }
}

export function toEnded(r: EndedRow): EndedSession {
  return {
    id: r.id, sessionId: r.session_id, runtime: r.runtime, title: r.title, folder: r.folder, project: r.project, repo: r.repo,
    agent: r.agent, branch: r.branch, topic: r.topic, lastText: r.last_text, endedAt: r.ended_at, continueMode: continueMode(r),
    transcript: r.transcript, keptWorktree: r.kept_worktree,
    keptWorktreeRemoved: r.kept_worktree === null ? false : !existsSync(r.kept_worktree),
    threadNote: r.thread_note,
  };
}

/** The store archiveChats moved into `archiveDir`: a chat thread (`<id>.sqlite`) or a tmux mirror (`<id>.mirror.sqlite`). */
function archivedStoreFile(archiveDir: string, sessionId: string): string | null {
  for (const name of [`${sessionId}.sqlite`, `${sessionId}.mirror.sqlite`]) if (existsSync(join(archiveDir, name))) return name;
  return null;
}

/** Lists the ended session whose store end() archived into `archiveDir` (`<id>-<stamp>`, chatArchive.ts). Without a
 *  store, a tmux session (whose Chat view was never mirrored) is listed as ended without a transcript, so its owner
 *  sees it ended; anything else (an InstaBox session, a chat that never opened) is not listed: null. `archiveDir` null:
 *  nothing was archived; `id` names the row then. `truncated`: the last read before the end stopped short
 *  (TranscriptMirror.finalRefresh). Seals the store for read-only use (ThreadStore.sealArchive). Throws when the
 *  archived store cannot be read. */
export function recordEnded(db: Database, s: SessionRow, archiveDir: string | null, endedAt: number,
  o: { id?: string; truncated?: boolean; keptWorktree?: string | null; threadNote?: string } = {}): EndedSession | null {
  const file = archiveDir === null ? null : archivedStoreFile(archiveDir, s.id);
  const runtime = s.runtime === "chat" ? "chat" : "tmux";
  if (file === null && runtime !== "tmux") return null;
  const id = archiveDir === null ? o.id : archiveDir.slice(archiveDir.lastIndexOf("/") + 1);
  if (id === undefined) throw new Error(`recordEnded: no archive and no id for ${s.id}`);
  let first: string | null = null, last: string | null = null, native: { harness: string; nativeThreadId: string } | null = null;
  if (file !== null) {
    const path = join(archiveDir!, file);
    ThreadStore.sealArchive(path);
    const store = ThreadStore.openArchived(path);
    try {
      first = store.firstUserText();
      last = store.lastMessageText();
      // A note means the conversation the session ended on is not known: the store's is an earlier one, not recorded.
      native = o.threadNote === undefined ? store.snapshot({ limit: 0 }).native : null;
    } finally { store.close(); }
  }
  const row: EndedRow = {
    id, session_id: s.id, folder: s.folder, project: s.project, repo: s.repo,
    // `agent` is optional in SessionRow only for insert literals; the column is NOT NULL.
    agent: s.agent!, runtime, title: s.name || `${s.project}/${s.repo}`, branch: s.branch ?? null,
    topic: first === null ? null : threadTitle(first), last_text: last === null ? null : clip(last, LAST_TEXT_MAX), ended_at: endedAt,
    archive_dir: archiveDir ?? "", store_file: file ?? "", native_harness: native?.harness ?? null, native_thread: native?.nativeThreadId ?? null, hidden_at: null,
    transcript: file === null ? "missing" : o.truncated ? "truncated" : "complete", kept_worktree: o.keptWorktree ?? null,
    thread_note: o.threadNote ?? null,
  };
  db.query(`INSERT OR REPLACE INTO ended_sessions (id,session_id,folder,project,repo,agent,runtime,title,branch,topic,last_text,ended_at,archive_dir,store_file,native_harness,native_thread,hidden_at,transcript,kept_worktree,thread_note)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,?,?)`).run(row.id, row.session_id, row.folder, row.project, row.repo, row.agent, row.runtime, row.title,
    row.branch, row.topic, row.last_text, row.ended_at, row.archive_dir, row.store_file, row.native_harness, row.native_thread, row.transcript, row.kept_worktree, row.thread_note);
  return toEnded(row);
}

/** Whether this session (`s`, by its id and creation: ids are reused) already has an ended row: an end resumed
 *  after a restart, whose first run listed the transcript before devd went down. */
export function endedAlready(db: Database, s: SessionRow): boolean {
  return db.query(`SELECT 1 FROM ended_sessions WHERE session_id=? AND ended_at >= ?`).get(s.id, s.created_at) !== null;
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

/** The transcript is not there to read: the session ended without one, or it was removed from the archive. */
export class TranscriptGone extends Error {}

/** The archived store, opened read-only for its snapshot. The caller closes it. */
export function openTranscript(row: EndedRow): ThreadStore {
  if (row.transcript === "missing") throw new TranscriptGone(`${row.id} ended without a transcript${row.thread_note ? `: ${row.thread_note}` : ""}`);
  const path = join(row.archive_dir, row.store_file);
  if (!existsSync(path)) throw new TranscriptGone(`the transcript of ${row.id} is missing: ${path}`);
  return ThreadStore.openArchived(path);
}

/** The archived images of an ended session (archiveThreadImages). */
export const endedImagesDir = (row: EndedRow) => join(row.archive_dir, "images");

/** Removes the transcripts that ended more than 30 days ago. It deletes only what keeping transcripts added: the row,
 *  a tmux session's mirror store and the images (end() deleted them before). The chat archive stays as it always did,
 *  forever: a chat thread's `<id>.sqlite` and the Claude projects dir (the jsonl). (A handoff's copy of the transcript
 *  lives in the new session's own control dir and goes with that session.) A failed removal is logged and the row stays
 *  for the next run. Returns the purged ids. */
export function purgeEnded(db: Database, now: number, log: (msg: string) => void,
  remove: (path: string) => void = (p) => rmSync(p, { recursive: true, force: true })): string[] {
  const due = db.query(`SELECT * FROM ended_sessions WHERE ended_at < ?`).all(now - ENDED_RETENTION_MS) as EndedRow[];
  const purged: string[] = [];
  for (const r of due) {
    try {
      if (r.store_file.endsWith(".mirror.sqlite")) for (const x of ["", "-wal", "-shm"]) remove(join(r.archive_dir, `${r.store_file}${x}`));
      if (r.archive_dir !== "") remove(endedImagesDir(r));
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

/** Where the new session reads the handoff's transcript: its own control dir, mounted into it alone (sessions.ts
 *  syncContinueFiles), never the shared /inbox. */
export const HANDOFF_TRANSCRIPT = "/run/devd/ended-transcript.md";

/** The whole transcript as Markdown, for the new session (HANDOFF_TRANSCRIPT). Throws TranscriptGone without one. */
export function handoffTranscript(row: EndedRow): string {
  const store = openTranscript(row);
  try { return renderTranscript(row, store.snapshot()); } finally { store.close(); }
}

/** The new session's first message: what the ended session was about, its last message and where the rest is. */
/** `notResumed`: why the ended Claude conversation itself could not be resumed (continuePlan), said first. */
export function handoffPrompt(row: EndedRow, notResumed: string | null = null): string {
  // What reaches the agent is devd's own text; the quoted parts came from the agent and may carry control characters.
  // eslint-disable-next-line no-control-regex -- the point of the replace
  const plain = (t: string) => t.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, " ");
  const where = `${row.project}/${row.repo}${row.branch ? `, branch ${row.branch}` : ""}`;
  return [
    ...(notResumed ? [`(The earlier conversation could not be resumed: ${plain(notResumed)}. This is a handoff instead.)`] : []),
    `This session continues an earlier one that has ended: "${plain(row.title)}" (${where}).`,
    ...(row.topic ? [`It started with: ${plain(row.topic)}`] : []),
    ...(row.last_text ? [`Its last message was: ${plain(row.last_text)}`] : []),
    `The whole earlier conversation is in ${HANDOFF_TRANSCRIPT}. Read it, then say in a few sentences where it left off and wait for what I want next.`,
  ].join("\n\n");
}
