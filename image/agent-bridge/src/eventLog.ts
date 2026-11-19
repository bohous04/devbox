import { appendFileSync, closeSync, fstatSync, openSync, readSync } from "node:fs";
import { replaceFileDurably, writeAll } from "./durable";
import type { BridgeEvent, LoggedEvent } from "./events";

const CHUNK = 1 << 20;
const NL = 0x0a;
/** Below this size the log is never rewritten: trimming it would save little. */
export const COMPACT_MIN_BYTES = 16 << 20;

function openForRead(path: string): number | null {
  try {
    return openSync(path, "r");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function parseLine(line: Buffer): LoggedEvent | null {
  try {
    return JSON.parse(line.toString("utf8")) as LoggedEvent;
  } catch {
    return null;
  }
}

/** The log's lines up to its size at the first `next()`, read in chunks (never the whole file at once). Only
 *  complete lines count: a crash mid-append leaves a torn line (append() terminates it), which is skipped and
 *  reported to `onSkip`. */
function* lines(path: string, onSkip: () => void = () => {}): Generator<{ raw: Buffer; event: LoggedEvent }> {
  const fd = openForRead(path);
  if (fd === null) return;
  try {
    const size = fstatSync(fd).size;
    let pos = 0;
    let rest = Buffer.alloc(0);
    while (pos < size) {
      const chunk = Buffer.alloc(Math.min(CHUNK, size - pos));
      const n = readSync(fd, chunk, 0, chunk.length, pos);
      if (n <= 0) break;
      pos += n;
      const buf = rest.length ? Buffer.concat([rest, chunk.subarray(0, n)]) : chunk.subarray(0, n);
      let start = 0;
      let nl: number;
      while ((nl = buf.indexOf(NL, start)) >= 0) {
        const raw = buf.subarray(start, nl);
        start = nl + 1;
        if (raw.length === 0) continue;
        const event = parseLine(raw);
        if (event === null) onSkip();
        else yield { raw, event };
      }
      rest = Buffer.from(buf.subarray(start));
    }
    if (rest.length) {
      const event = parseLine(rest);
      if (event === null) onSkip();
      else yield { raw: rest, event };
    }
  } finally {
    closeSync(fd);
  }
}

/** Seq of the last parseable line, read from the end of the file backwards. */
function tailSeq(fd: number, size: number): number {
  let pos = size;
  let tail = Buffer.alloc(0);
  let step = 64 << 10;
  while (pos > 0) {
    const n = Math.min(step, pos);
    pos -= n;
    step *= 2;
    const chunk = Buffer.alloc(n);
    readSync(fd, chunk, 0, n, pos);
    tail = Buffer.concat([chunk, tail]);
    // Before the first newline in `tail` the line may continue further back, unless this is the file's start.
    const firstNl = tail.indexOf(NL);
    const from = pos === 0 ? 0 : firstNl < 0 ? tail.length : firstNl + 1;
    let end = tail.length;
    while (end > from) {
      const nl = tail.lastIndexOf(NL, end - 1);
      const lineStart = nl < from ? from : nl + 1;
      if (end > lineStart) {
        const e = parseLine(tail.subarray(lineStart, end));
        if (e !== null) return e.seq;
      }
      end = nl < from ? from : nl;
    }
    tail = tail.subarray(0, from);
  }
  return 0;
}

/** What the log says is still open: runs announced (queued or started) without a terminal event, requests opened
 *  and not resolved, and the latest `thread.native`. */
export interface LogScan {
  lastSeq: number;
  /** Run id (in order of first announcement) → whether `run.started` was seen, and the `run.queued` message if any. */
  openRuns: Map<string, { started: boolean; queued: { text: string; attachments: string[]; origin?: "critic" } | null }>;
  openRequests: Set<string>;
  lastNative: { seq: number; event: Extract<BridgeEvent, { type: "thread.native" }> } | null;
}

const TERMINAL = new Set(["run.completed", "run.failed", "run.interrupted"]);

function runIdOf(e: BridgeEvent): string | null {
  return "runId" in e && typeof e.runId === "string" ? e.runId : null;
}

export class EventLog {
  private seq: number;
  // Computed once on open so append() never has to re-read the file.
  private tailUnterminated: boolean;
  /** Size right after the last compaction (0 before one): the log is compacted again once it doubled. */
  private compactedSize = 0;
  private readonly logError: (msg: string) => void;
  private readonly compactMinBytes: number;

  constructor(private readonly path: string, o: { logError?: (msg: string) => void; compactMinBytes?: number } = {}) {
    this.logError = o.logError ?? ((msg) => console.error(msg));
    this.compactMinBytes = o.compactMinBytes ?? COMPACT_MIN_BYTES;
    const fd = openForRead(path);
    if (fd === null) {
      this.seq = 0;
      this.tailUnterminated = false;
      return;
    }
    try {
      const size = fstatSync(fd).size;
      this.seq = tailSeq(fd, size);
      const last = Buffer.alloc(1);
      this.tailUnterminated = size > 0 && readSync(fd, last, 0, 1, size - 1) === 1 && last[0] !== NL;
    } finally {
      closeSync(fd);
    }
  }

  append(event: BridgeEvent): LoggedEvent {
    const logged: LoggedEvent = { seq: this.seq + 1, ts: Date.now(), event };
    // Leading newline terminates any torn line left by a crash, so this record starts clean.
    appendFileSync(this.path, `${this.tailUnterminated ? "\n" : ""}${JSON.stringify(logged)}\n`);
    this.tailUnterminated = false;
    this.seq = logged.seq;
    return logged;
  }

  lastSeq(): number {
    return this.seq;
  }

  /** Events after `afterSeq`, streamed from disk up to the log's end at the first `next()`. */
  *stream(afterSeq: number): Generator<LoggedEvent> {
    for (const { event } of lines(this.path)) if (event.seq > afterSeq) yield event;
  }

  readFrom(afterSeq: number): LoggedEvent[] {
    return [...this.stream(afterSeq)];
  }

  scan(): LogScan {
    const s: LogScan = { lastSeq: 0, openRuns: new Map(), openRequests: new Set(), lastNative: null };
    for (const { seq, event: e } of this.stream(0)) {
      s.lastSeq = seq;
      if (e.type === "thread.native") s.lastNative = { seq, event: e };
      else if (e.type === "request.opened") s.openRequests.add(e.requestId);
      else if (e.type === "request.resolved") s.openRequests.delete(e.requestId);
      if (e.type === "run.queued" || e.type === "run.started") {
        const r = s.openRuns.get(e.runId) ?? { started: false, queued: null };
        if (e.type === "run.queued") r.queued = { text: e.text, attachments: e.attachments, ...(e.origin ? { origin: e.origin } : {}) };
        else r.started = true;
        s.openRuns.set(e.runId, r);
      } else if (TERMINAL.has(e.type)) s.openRuns.delete(runIdOf(e)!);
    }
    return s;
  }

  /** Drops what devd acknowledged (`seq <= ackedSeq`) once the log is big (COMPACT_MIN_BYTES, and doubled since the
   *  last compaction). Kept regardless: every event of a run without a terminal event and of a request not resolved
   *  (the next start derives them from the log), the latest `thread.native` (a lost state.json is rebuilt from it) and
   *  the last event (the seq continues from it). Replaced durably (temp file, fsync, rename). Returns the number of
   *  events dropped, or null when the log is below the size thresholds and was not rewritten. */
  compact(ackedSeq: number): number | null {
    const fd = openForRead(this.path);
    if (fd === null) return null;
    let size: number;
    try {
      size = fstatSync(fd).size;
    } finally {
      closeSync(fd);
    }
    if (ackedSeq <= 0 || size < this.compactMinBytes || size < 2 * this.compactedSize) return null;
    const s = this.scan();
    const keep = (e: LoggedEvent): boolean => {
      if (e.seq > ackedSeq || e.seq === s.lastSeq || e.seq === s.lastNative?.seq) return true;
      const runId = runIdOf(e.event);
      if (runId !== null && s.openRuns.has(runId)) return true;
      return e.event.type === "request.opened" && s.openRequests.has(e.event.requestId);
    };
    let dropped = 0;
    let torn = 0;
    replaceFileDurably(this.path, (out) => {
      for (const { raw, event } of lines(this.path, () => torn++)) {
        if (!keep(event)) {
          dropped++;
          continue;
        }
        writeAll(out, raw);
        writeAll(out, "\n");
      }
    });
    if (torn > 0) this.logError(`agent-bridge: compacting events.jsonl dropped ${torn} unparseable line(s) (torn by a crash or corrupt)`);
    // Every kept line is complete now.
    this.tailUnterminated = false;
    this.compactedSize = this.sizeNow();
    return dropped;
  }

  private sizeNow(): number {
    const fd = openSync(this.path, "r");
    try {
      return fstatSync(fd).size;
    } finally {
      closeSync(fd);
    }
  }
}
