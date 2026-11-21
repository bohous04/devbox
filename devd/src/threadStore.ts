import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseCommands } from "../../shared/commands";
import { parseEffortState } from "../../shared/effort";
import type { AgentCommand, BackgroundWork, Capabilities, LoggedEvent, PendingRequest, RunRow, ThreadEffort, ThreadItem, ThreadSnapshot } from "../../shared/thread";

const TERMINAL: ReadonlySet<string> = new Set(["completed", "interrupted", "failed"]);
/** A user item's images; no field when the message has none (same rule in dashboard/src/threadView.ts). */
const withAttachments = (a: string[] | undefined): { attachments?: string[] } => (a !== undefined && a.length > 0 ? { attachments: a } : {});

/** A native thread this session has used, kept so a later switch back to its harness can resume it. */
export interface ProviderThread {
  harness: string;
  account: string | null;
  nativeThreadId: string;
  /** The last run this thread has seen; null until a run started in it. */
  coveredThroughRun: string | null;
  lastUsedAt: number;
  /** null until the bridge reports capabilities with `thread.native`. */
  caps: Capabilities | null;
  /** Resuming it failed; cleared when the bridge announces the thread again. */
  resumeFailed: boolean;
}

/** The thread store's schema (`PRAGMA user_version`). A change to the schema raises it and adds a migration from the
 *  previous version in `open`; a store with a higher version (written by a newer devd) is refused, never guessed at. */
export const THREAD_STORE_SCHEMA = 4;

/** Per-session conversation store: `<root>/_threads/<id>.sqlite`. Conversation data stays out of the
 *  main devd DB on purpose. Items are ordered by their own `id`; `seq` is the log seq of the event that created them (one event can create
 *  several items); `updated_seq`
 *  is the seq of their last change, so `snapshot({afterSeq})` also returns items that kept streaming. */
export class ThreadStore {
  /** Effort fields (model, supported, effective, chosen) already logged with a dropped value: one line per field per
   *  session, so a bridge sending ever new values cannot grow the log or this set. */
  private effortLogged = new Set<string>();
  private commandsLogged = new Set<string>();

  private constructor(private db: Database, private onNotice: (item: ThreadItem) => void) {}

  static path(root: string, sessionId: string): string {
    return join(root, "_threads", `${sessionId}.sqlite`);
  }

  /** `onNotice`: a notice devd added (addNotice), for the session's SSE stream (index.ts publishes it). */
  static open(root: string, sessionId: string, opts: { onNotice?: (item: ThreadItem) => void } = {}): ThreadStore {
    mkdirSync(join(root, "_threads"), { recursive: true });
    const db = new Database(ThreadStore.path(root, sessionId));
    db.run("PRAGMA busy_timeout = 5000");
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA synchronous = NORMAL");
    const version = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
    if (version > THREAD_STORE_SCHEMA) {
      db.close();
      throw new Error(`thread store schema ${version} is newer than this devd's (${THREAD_STORE_SCHEMA}): ${ThreadStore.path(root, sessionId)}`);
    }
    if (version === 0) db.transaction(() => ThreadStore.createSchema1(db))();
    if (version <= 1) db.transaction(() => ThreadStore.migrateTo2(db))();
    if (version <= 2) db.transaction(() => ThreadStore.migrateTo3(db))();
    if (version <= 3) db.transaction(() => ThreadStore.migrateTo4(db))();
    return new ThreadStore(db, opts.onNotice ?? (() => {}));
  }

  /** Schema 1: every store from before `user_version` (steps 2-5 created and extended them without one) and every new
   *  store. Idempotent on purpose: an unversioned store may be of any shape step 2-5 shipped, so tables are created if
   *  missing and the columns added since step 2 are added if missing. */
  private static createSchema1(db: Database) {
    db.run(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL)`);
    db.run(`CREATE TABLE IF NOT EXISTS runs (
      run_id TEXT PRIMARY KEY, origin TEXT NOT NULL, status TEXT NOT NULL, harness TEXT,
      native_thread_id TEXT, model TEXT, queued_at INTEGER, started_at INTEGER, ended_at INTEGER, ended_seq INTEGER, usage TEXT, error TEXT,
      updated_seq INTEGER NOT NULL)`);
    db.run(`CREATE TABLE IF NOT EXISTS items (
      id INTEGER PRIMARY KEY AUTOINCREMENT, seq INTEGER NOT NULL, run_id TEXT, item_id TEXT, kind TEXT NOT NULL, text TEXT NOT NULL,
      tool TEXT, input TEXT, output TEXT, is_error INTEGER, status TEXT, ts INTEGER NOT NULL,
      updated_seq INTEGER NOT NULL)`);
    db.run(`CREATE INDEX IF NOT EXISTS items_key ON items (run_id, item_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS items_updated ON items (updated_seq)`);
    db.run(`CREATE TABLE IF NOT EXISTS requests (
      request_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, kind TEXT NOT NULL, prompt TEXT NOT NULL,
      options TEXT, multi_select INTEGER, opened_at INTEGER NOT NULL, status TEXT NOT NULL)`);
    db.run(`CREATE TABLE IF NOT EXISTS background (id INTEGER PRIMARY KEY CHECK (id = 1), work TEXT NOT NULL)`);
    db.run(`CREATE TABLE IF NOT EXISTS native (
      id INTEGER PRIMARY KEY CHECK (id = 1), harness TEXT NOT NULL, native_thread_id TEXT NOT NULL,
      account TEXT, model TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS provider_threads (
      harness TEXT NOT NULL, account TEXT, native_thread_id TEXT NOT NULL, covered_through_run TEXT,
      last_used_at INTEGER NOT NULL, caps TEXT, resume_failed INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (harness, native_thread_id))`);
    // Stores created before run.failed carried a reason lack the column.
    if (!(db.query("PRAGMA table_info(runs)").all() as { name: string }[]).some((c) => c.name === "failure_reason")) {
      db.run("ALTER TABLE runs ADD COLUMN failure_reason TEXT");
    }
    // Stores created before user messages carried images lack the column.
    if (!(db.query("PRAGMA table_info(items)").all() as { name: string }[]).some((c) => c.name === "attachments")) {
      db.run("ALTER TABLE items ADD COLUMN attachments TEXT");
    }
    db.run(`PRAGMA user_version = 1`);
  }

  /** Schema 2: the effort table (the agent's reasoning effort, effort.state). Stores already at version 1 lacked it. */
  private static migrateTo2(db: Database) {
    db.run(`CREATE TABLE IF NOT EXISTS effort (id INTEGER PRIMARY KEY CHECK (id = 1), state TEXT NOT NULL)`);
    db.run(`PRAGMA user_version = 2`);
  }

  /** Schema 3: a notice's tone (ThreadItem.tone). Idempotent like the others. */
  private static migrateTo3(db: Database) {
    if (!(db.query("PRAGMA table_info(items)").all() as { name: string }[]).some((c) => c.name === "tone")) {
      db.run("ALTER TABLE items ADD COLUMN tone TEXT");
    }
    db.run(`PRAGMA user_version = 3`);
  }

  /** Schema 4: each harness's latest slash commands (commands.changed), kept per harness so a switch back finds its own. */
  private static migrateTo4(db: Database) {
    db.run(`CREATE TABLE IF NOT EXISTS commands (harness TEXT PRIMARY KEY, list TEXT NOT NULL)`);
    db.run(`PRAGMA user_version = 4`);
  }

  lastSeq(): number { return this.meta("last_seq"); }

  /** `lastSeq` once it is on disk, for the bridge's periodic ack (S6-R21): with synchronous=NORMAL the newest WAL
   *  commits are synced only by a checkpoint, so this runs one (PASSIVE: it never waits). null when the checkpoint
   *  could not copy the whole WAL (another connection's read snapshot holds part of it). */
  durableSeq(): number | null {
    const seq = this.lastSeq();
    const r = this.db.query("PRAGMA wal_checkpoint(PASSIVE)").get() as { busy: number; log: number; checkpointed: number };
    return r.busy === 0 && r.checkpointed === r.log ? seq : null;
  }

  private meta(key: string): number {
    const r = this.db.query("SELECT value FROM meta WHERE key=?").get(key) as { value: number } | null;
    return r ? r.value : 0;
  }

  private setMeta(key: string, value: number) {
    this.db.query("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
  }

  markSeen(seq: number): void {
    if (seq > this.lastSeq()) throw new Error(`markSeen(${seq}) is above lastSeq ${this.lastSeq()}`);
    if (seq > this.meta("seen_seq")) this.setMeta("seen_seq", seq);
  }

  /** False when the event was already applied (`seq <= lastSeq`). A gap is accepted: the log may be trimmed. */
  apply(e: LoggedEvent): boolean {
    if (e.seq <= this.lastSeq()) return false;
    this.db.transaction(() => {
      this.dispatch(e);
      this.setMeta("last_seq", e.seq);
    })();
    return true;
  }

  private dispatch({ seq, ts, event: ev }: LoggedEvent) {
    const db = this.db;
    switch (ev.type) {
      case "thread.native":
        db.query(`INSERT INTO native (id, harness, native_thread_id, account, model) VALUES (1, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET harness=excluded.harness, native_thread_id=excluded.native_thread_id,
          account=excluded.account,
          -- A resumed Claude thread is announced before the CLI names its model: null keeps the harness's known one.
          -- A proxy profile has no account and its own model, so a model is never carried to or from it.
          model=COALESCE(excluded.model, CASE WHEN native.harness=excluded.harness AND native.account IS NOT NULL
            AND excluded.account IS NOT NULL THEN native.model END)`).run(ev.harness, ev.nativeThreadId, ev.account, ev.model);
        // caps describe the adapter that announced the thread now: an announcement without them clears old ones.
        db.query(`INSERT INTO provider_threads (harness, account, native_thread_id, last_used_at, caps) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(harness, native_thread_id) DO UPDATE SET account=excluded.account, last_used_at=excluded.last_used_at,
          caps=excluded.caps, resume_failed=0`).run(ev.harness, ev.account, ev.nativeThreadId, ts, ev.caps ? JSON.stringify(ev.caps) : null);
        // A run that started before its thread was known (Claude announces it at init, inside the run) ran in it.
        for (const r of db.query(`SELECT run_id FROM runs WHERE status='running' AND native_thread_id IS NULL`).all() as { run_id: string }[]) {
          db.query(`UPDATE runs SET native_thread_id=?, updated_seq=? WHERE run_id=?`).run(ev.nativeThreadId, seq, r.run_id);
          this.touchProviderThread(r.run_id, ts);
        }
        return;
      case "run.queued":
        this.insertRun(seq, ev.runId, ev.origin ?? "user", "queued", null, null, ts, null);
        this.insertItem(seq, ts, { runId: ev.runId, itemId: `user:${ev.runId}`, kind: "user", text: ev.text, status: "done", ...withAttachments(ev.attachments) });
        return;
      case "run.started": {
        const row = db.query("SELECT status FROM runs WHERE run_id=?").get(ev.runId) as { status: string } | null;
        if (!row) this.insertRun(seq, ev.runId, ev.origin, "running", ev.nativeThreadId, ev.model, null, ts);
        else if (row.status === "queued") {
          db.query(`UPDATE runs SET origin=?, status='running', native_thread_id=?, model=?, started_at=?, updated_seq=? WHERE run_id=?`)
            .run(ev.origin, ev.nativeThreadId, ev.model, ts, seq, ev.runId);
        } else return; // A start for a run that already ended or runs is a replay artefact: do not regress it.
        this.touchProviderThread(ev.runId, ts);
        return;
      }
      case "message.delta": {
        // The harness may keep streaming after an interrupt until its result: the run is over, the item stays done.
        const run = db.query("SELECT status FROM runs WHERE run_id=?").get(ev.runId) as { status: string } | null;
        if (run && TERMINAL.has(run.status)) return;
        const it = this.findItem(ev.runId, ev.itemId);
        if (!it) this.insertItem(seq, ts, { runId: ev.runId, itemId: ev.itemId, kind: "assistant", text: ev.text, status: "streaming" });
        else db.query(`UPDATE items SET text=text||?, status='streaming', updated_seq=? WHERE id=?`).run(ev.text, seq, it.id);
        return;
      }
      case "message.final": {
        if (ev.role === "user") {
          // The user's text already came with run.queued; a harness echo must not duplicate it.
          const has = db.query("SELECT 1 FROM items WHERE run_id=? AND kind='user'").get(ev.runId);
          if (!has) this.insertItem(seq, ts, { runId: ev.runId, itemId: ev.itemId, kind: "user", text: ev.text, status: "done", ...withAttachments(ev.attachments) });
          return;
        }
        const it = this.findItem(ev.runId, ev.itemId);
        if (!it) this.insertItem(seq, ts, { runId: ev.runId, itemId: ev.itemId, kind: "assistant", text: ev.text, status: "done" });
        else db.query(`UPDATE items SET text=?, status='done', updated_seq=? WHERE id=?`).run(ev.text, seq, it.id);
        return;
      }
      case "tool.started":
        if (this.findItem(ev.runId, ev.itemId)) return; // re-announcement
        this.insertItem(seq, ts, { runId: ev.runId, itemId: ev.itemId, kind: "tool", text: "", tool: ev.tool, input: ev.input, status: "streaming" });
        return;
      case "tool.finished": {
        const it = this.findItem(ev.runId, ev.itemId);
        if (!it) {
          // The start was trimmed from the log: show the result, marked as an unknown tool.
          this.insertItem(seq, ts, { runId: ev.runId, itemId: ev.itemId, kind: "tool", text: "", tool: "(unknown)", output: ev.output, isError: ev.isError, status: "done" });
        } else {
          db.query(`UPDATE items SET output=?, is_error=?, status='done', updated_seq=? WHERE id=?`).run(ev.output, ev.isError ? 1 : 0, seq, it.id);
        }
        return;
      }
      case "request.opened":
        if (db.query("SELECT 1 FROM requests WHERE request_id=?").get(ev.requestId)) return; // re-announcement
        db.query(`INSERT INTO requests (request_id, run_id, kind, prompt, options, multi_select, opened_at, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'open')`)
          .run(ev.requestId, ev.runId, ev.kind, ev.prompt, ev.options ? JSON.stringify(ev.options) : null, ev.multiSelect === undefined ? null : ev.multiSelect ? 1 : 0, ts);
        this.insertItem(seq, ts, { runId: ev.runId, itemId: ev.requestId, kind: "request", text: ev.prompt, status: "open" });
        return;
      case "request.resolved": {
        const status = ev.by === "expired" ? "expired" : "answered";
        db.query(`UPDATE requests SET status=? WHERE request_id=?`).run(status, ev.requestId);
        // The request may predate this store's items (trimmed log): then there is nothing to flip.
        db.query(`UPDATE items SET status=?, output=?, updated_seq=? WHERE kind='request' AND item_id=?`)
          .run(status, ev.answer, seq, ev.requestId);
        return;
      }
      case "background.changed":
        db.query(`INSERT INTO background (id, work) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET work=excluded.work`).run(JSON.stringify(ev.work));
        return;
      case "run.completed":
        this.terminal(seq, ts, ev.runId, "completed", { nativeThreadId: ev.nativeThreadId, usage: ev.usage, error: null }, true);
        return;
      case "run.interrupted":
        this.terminal(seq, ts, ev.runId, "interrupted", { error: null });
        return;
      case "run.failed":
        // resume-failed and open-failed come for a switch or the bridge's start, not a run: their run id was never
        // announced (contract with the bridge). devd says them in notices of its own (chatSwitch), so the event adds none.
        if ((ev.error === "resume-failed" || ev.error === "open-failed") && !db.query("SELECT 1 FROM runs WHERE run_id=?").get(ev.runId)) return;
        // Only reasons devd knows reach the inbox; any other value from a newer bridge leaves the run plainly failed.
        this.terminal(seq, ts, ev.runId, "failed", { error: ev.error, failureReason: ev.reason === "rate-limited" ? ev.reason : null });
        this.insertItem(seq, ts, { runId: ev.runId, itemId: null, kind: "notice", text: ev.error, status: "done" });
        return;
      case "bridge.started":
        if (ev.resumed) this.insertItem(seq, ts, { runId: null, itemId: null, kind: "notice", text: `Agent bridge restarted (v${ev.version})`, status: "done" });
        if (ev.notice) this.insertItem(seq, ts, { runId: null, itemId: null, kind: "notice", text: ev.notice, status: "done" });
        return;
      case "bridge.notice":
        this.insertItem(seq, ts, { runId: null, itemId: null, kind: "notice", text: ev.text, status: "done" });
        return;
      case "effort.state": {
        // Parsed whatever its shape (shared/effort.ts): the bridge's values reach the UI only as known levels.
        const state = this.parseEffort(ev, `seq ${seq}`);
        db.query("INSERT INTO effort (id, state) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET state=excluded.state").run(JSON.stringify(state));
        return;
      }
      case "commands.changed": {
        const n = db.query("SELECT harness FROM native WHERE id=1").get() as { harness: string } | null;
        if (n === null) {
          console.error(`thread store: commands.changed at seq ${seq} before any thread.native dropped`);
          return;
        }
        const list = this.parseCommands(ev.commands, `seq ${seq}`);
        db.query("INSERT INTO commands (harness, list) VALUES (?, ?) ON CONFLICT(harness) DO UPDATE SET list=excluded.list").run(n.harness, JSON.stringify(list));
        return;
      }
      default: {
        const unknown: never = ev;
        const type = (unknown as { type?: unknown }).type;
        console.error(`thread store: unknown event type ${String(type)} at seq ${seq}`);
        this.insertItem(seq, ts, { runId: null, itemId: null, kind: "notice", text: `unknown event ${String(type)}`, status: "done" });
      }
    }
  }

  private insertRun(seq: number, runId: string, origin: string, status: string, nativeThreadId: string | null, model: string | null, queuedAt: number | null, startedAt: number | null) {
    const n = this.db.query("SELECT harness FROM native WHERE id=1").get() as { harness: string } | null;
    // harness stays null until the bridge has announced its native thread.
    this.db.query(`INSERT OR IGNORE INTO runs (run_id, origin, status, harness, native_thread_id, model, queued_at, started_at, updated_seq)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(runId, origin, status, n?.harness ?? null, nativeThreadId, model, queuedAt, startedAt, seq);
  }

  private terminal(seq: number, ts: number, runId: string, status: RunRow["status"],
    f: { nativeThreadId?: string; usage?: unknown; error: string | null; failureReason?: string | null }, setUsage = false) {
    const row = this.db.query("SELECT 1 FROM runs WHERE run_id=?").get(runId);
    if (!row) {
      this.insertItem(seq, ts, { runId, itemId: null, kind: "notice", text: `${status} event for unknown run ${runId}`, status: "done" });
      return;
    }
    // The later terminal event wins, also over an earlier terminal status.
    // Only run.completed reports usage; a later interrupted/failed keeps it.
    this.db.query(`UPDATE runs SET status=?, ended_at=?, ended_seq=?, error=?, failure_reason=?,
      native_thread_id=COALESCE(?, native_thread_id), usage=CASE WHEN ? THEN ? ELSE usage END, updated_seq=? WHERE run_id=?`)
      .run(status, ts, seq, f.error, f.failureReason ?? null, f.nativeThreadId ?? null, setUsage ? 1 : 0, f.usage ? JSON.stringify(f.usage) : null, seq, runId);
    this.db.query(`UPDATE items SET status='done', updated_seq=? WHERE run_id=? AND status='streaming'`).run(seq, runId);
    this.touchProviderThread(runId, ts);
  }

  /** The run's own native thread has seen `runId`. While that thread is unknown nothing is marked: the
   *  `thread.native` inside the run or `run.completed` names it later. */
  private touchProviderThread(runId: string, ts: number) {
    const r = this.db.query("SELECT native_thread_id FROM runs WHERE run_id=?").get(runId) as { native_thread_id: string | null } | null;
    if (r?.native_thread_id == null) return;
    this.db.query(`UPDATE provider_threads SET covered_through_run=?, last_used_at=? WHERE native_thread_id=?`)
      .run(runId, ts, r.native_thread_id);
  }

  /** Resuming `nativeThreadId` failed: later plans must not try it again. A thread without a row (a store file
   *  from before provider_threads) gets one, so the flag is never lost. */
  markResumeFailed(harness: string, nativeThreadId: string, ts: number): void {
    this.db.query(`INSERT INTO provider_threads (harness, account, native_thread_id, last_used_at, resume_failed) VALUES (?, NULL, ?, ?, 1)
      ON CONFLICT(harness, native_thread_id) DO UPDATE SET resume_failed=1`).run(harness, nativeThreadId, ts);
  }

  private findItem(runId: string, itemId: string): { id: number } | null {
    return this.db.query("SELECT id FROM items WHERE run_id=? AND item_id=?").get(runId, itemId) as { id: number } | null;
  }

  private insertItem(seq: number, ts: number, i: Omit<ThreadItem, "seq" | "ts">) {
    this.db.query(`INSERT INTO items (seq, run_id, item_id, kind, text, tool, input, output, is_error, status, ts, updated_seq, attachments, tone)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      seq, i.runId, i.itemId, i.kind, i.text, i.tool ?? null, i.input === undefined ? null : JSON.stringify(i.input),
      i.output ?? null, i.isError === undefined ? null : i.isError ? 1 : 0, i.status ?? null, ts, seq,
      i.attachments === undefined ? null : JSON.stringify(i.attachments), i.tone ?? null);
  }

  /** A notice devd itself adds (not a bridge event). Seqs belong to the bridge's log (the link's hello asks for
   *  everything after `lastSeq`, `apply` drops what is at or below it), so a notice takes none: it sits at the current
   *  seq with its own item id `notice:<n>` and is announced through `onNotice` (the SSE stream). A replay from that
   *  seq still includes it (see snapshot), for a client whose stream was down when it was added. */
  addNotice(text: string, ts: number, tone?: "warn"): void {
    this.notice(this.lastSeq(), text, ts, () => {}, tone);
  }

  /** Gives up on the bridge's event `seq` (above lastSeq), which devd cannot apply: it counts as applied, and the
   *  notice `text` takes its place at that seq. */
  skipEvent(seq: number, text: string, ts: number): void {
    if (seq <= this.lastSeq()) throw new Error(`skipEvent(${seq}) is not above lastSeq ${this.lastSeq()}`);
    this.notice(seq, text, ts, () => this.setMeta("last_seq", seq));
  }

  private notice(seq: number, text: string, ts: number, also: () => void, tone?: "warn") {
    const n = this.meta("notice_count") + 1;
    const item: ThreadItem = { seq, runId: null, itemId: `notice:${n}`, kind: "notice", text, status: "done", ts, ...(tone ? { tone } : {}) };
    this.db.transaction(() => {
      this.setMeta("notice_count", n);
      this.insertItem(seq, ts, item);
      also();
    })();
    this.onNotice(item);
  }

  /** Without `limit` all items; with it the newest `limit` ones, oldest first. `beforeSeq` keeps only items
   *  created before that seq (paging back through history); runs, pending requests etc. are not affected. */
  snapshot(opts: { afterSeq?: number; beforeSeq?: number; limit?: number } = {}): ThreadSnapshot {
    const after = opts.afterSeq ?? 0;
    const limit = opts.limit ?? -1;
    const before = opts.beforeSeq ?? Number.MAX_SAFE_INTEGER;
    const itemRows = this.db.query(
      // devd notices (addNotice) at the replay's own seq too: they took no seq of their own.
      `SELECT * FROM (SELECT * FROM items WHERE (updated_seq > ? OR (item_id LIKE 'notice:%' AND seq >= ?)) AND seq < ?
        ORDER BY id DESC LIMIT ?) ORDER BY id`,
    ).all(after, after, before, limit) as Record<string, any>[];
    const items: ThreadItem[] = itemRows.map((r) => {
      const it: ThreadItem = { seq: r.seq, runId: r.run_id, itemId: r.item_id, kind: r.kind, text: r.text, ts: r.ts };
      if (r.tool !== null) it.tool = r.tool;
      if (r.input !== null) it.input = JSON.parse(r.input);
      if (r.output !== null) it.output = r.output;
      if (r.is_error !== null) it.isError = r.is_error === 1;
      if (r.status !== null) it.status = r.status;
      if (r.attachments !== null) it.attachments = JSON.parse(r.attachments);
      if (r.tone === "warn") it.tone = "warn";
      return it;
    });
    const runs = (this.db.query(`SELECT * FROM runs WHERE updated_seq > ? ORDER BY rowid`).all(after) as Record<string, any>[])
      .map((r): RunRow => {
        const run: RunRow = {
          runId: r.run_id, origin: r.origin, status: r.status, harness: r.harness, nativeThreadId: r.native_thread_id,
          model: r.model, queuedAt: r.queued_at, startedAt: r.started_at, endedAt: r.ended_at, endedSeq: r.ended_seq, usage: r.usage === null ? null : JSON.parse(r.usage), error: r.error,
        };
        if (r.failure_reason !== null) run.failureReason = r.failure_reason;
        return run;
      });
    const pending = (this.db.query(`SELECT * FROM requests WHERE status='open' ORDER BY opened_at, rowid`).all() as Record<string, any>[])
      .map((r): PendingRequest => {
        const p: PendingRequest = { requestId: r.request_id, runId: r.run_id, kind: r.kind, prompt: r.prompt, openedAt: r.opened_at };
        if (r.options !== null) p.options = JSON.parse(r.options);
        if (r.multi_select !== null) p.multiSelect = r.multi_select === 1;
        return p;
      });
    const bg = this.db.query("SELECT work FROM background WHERE id=1").get() as { work: string } | null;
    const n = this.db.query("SELECT * FROM native WHERE id=1").get() as Record<string, any> | null;
    const commands = this.commands();
    return {
      lastSeq: this.lastSeq(), seenSeq: this.meta("seen_seq"), runs, items, pending,
      background: bg ? (JSON.parse(bg.work) as BackgroundWork[]) : [],
      native: n ? { harness: n.harness, nativeThreadId: n.native_thread_id, account: n.account, model: n.model } : null,
      effort: this.effort(),
      ...(commands !== null ? { commands } : {}),
    };
  }

  /** The current harness's slash commands, parsed again on the way out; null when that harness sent none. */
  commands(): AgentCommand[] | null {
    const row = this.db.query("SELECT c.list FROM commands c JOIN native n ON n.id=1 AND n.harness=c.harness").get() as { list: string } | null;
    if (row === null) return null;
    let raw: unknown;
    try { raw = JSON.parse(row.list); } catch { raw = null; }
    return this.parseCommands(raw, "the stored list");
  }

  private parseCommands(raw: unknown, where: string): AgentCommand[] {
    const { commands, dropped } = parseCommands(raw);
    for (const what of dropped) {
      if (this.commandsLogged.has(what)) continue;
      this.commandsLogged.add(what);
      console.error(`thread store: ${what} at ${where} dropped (later ones of this kind are not logged)`);
    }
    return commands;
  }

  /** The agent's reasoning effort from the latest effort.state, parsed again on the way out: a store written before
   *  the parser (or by hand) serves no other shape. null before one. */
  effort(): ThreadEffort | null {
    const row = this.db.query("SELECT state FROM effort WHERE id=1").get() as { state: string } | null;
    if (row === null) return null;
    let raw: unknown;
    try { raw = JSON.parse(row.state); } catch { raw = null; }
    return this.parseEffort(raw, "the stored state");
  }

  private parseEffort(raw: unknown, where: string): ThreadEffort {
    const { effort, dropped } = parseEffortState(raw);
    for (const what of dropped) {
      const field = what.split(" ")[0]!;
      if (this.effortLogged.has(field)) continue;
      this.effortLogged.add(field);
      console.error(`thread store: effort ${what} at ${where} dropped (later ones of this field are not logged)`);
    }
    return effort;
  }

  /** The most recently used native thread of `harness`, or null when this session never used that harness. */
  providerThread(harness: string): ProviderThread | null {
    const r = this.db.query(`SELECT * FROM provider_threads WHERE harness=? ORDER BY last_used_at DESC, rowid DESC LIMIT 1`)
      .get(harness) as Record<string, any> | null;
    if (!r) return null;
    return {
      harness: r.harness, account: r.account, nativeThreadId: r.native_thread_id, coveredThroughRun: r.covered_through_run,
      lastUsedAt: r.last_used_at, caps: r.caps === null ? null : (JSON.parse(r.caps) as Capabilities), resumeFailed: r.resume_failed === 1,
    };
  }

  /** The user message of run `runId` (the user's text, or the critic's follow-up); null while the store has none. */
  userText(runId: string): string | null {
    const r = this.db.query(`SELECT text FROM items WHERE run_id=? AND kind='user' LIMIT 1`).get(runId) as { text: string } | null;
    return r ? r.text : null;
  }

  /** Text of the newest user or assistant item (also one still streaming); null for a thread without messages. */
  /** The start of the thread's first user message with text (an attachment-only one has none); null before one.
   *  400 characters are plenty for a title (shared/threadTitle.ts). */
  firstUserText(): string | null {
    const r = this.db.query(`SELECT substr(text, 1, 400) AS text FROM items WHERE kind = 'user' AND text <> '' ORDER BY id LIMIT 1`).get() as { text: string } | null;
    return r ? r.text : null;
  }

  lastMessageText(): string | null {
    const r = this.db.query(`SELECT text FROM items WHERE kind IN ('user', 'assistant') ORDER BY id DESC LIMIT 1`).get() as { text: string } | null;
    return r ? r.text : null;
  }

  close(): void { this.db.close(); }
}
