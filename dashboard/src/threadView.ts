import type { LoggedEvent, RunRow, ThreadEffort, ThreadItem, ThreadSnapshot } from "../../shared/thread";

export const emptyThread = (): ThreadSnapshot => ({
  lastSeq: 0, seenSeq: 0, runs: [], items: [], pending: [], background: [], native: null, effort: null,
});

/** Applies one bridge event to the client's copy of a thread. Pure; mirrors `ThreadStore.apply` in
 *  devd/src/threadStore.ts (same rules, same item shapes), so live events and a later reload agree.
 *  Events at or below `lastSeq` were already applied and return `t` unchanged. */
export function applyThreadEvent(t: ThreadSnapshot, e: LoggedEvent): ThreadSnapshot {
  if (e.seq <= t.lastSeq) return t;
  const n: ThreadSnapshot = { ...t, lastSeq: e.seq, items: [...t.items], runs: [...t.runs], pending: [...t.pending] };
  dispatch(n, e);
  return n;
}

/** A user item's images; no field when the message has none (same rule in devd/src/threadStore.ts). */
const withAttachments = (a: string[] | undefined): { attachments?: string[] } => (a !== undefined && a.length > 0 ? { attachments: a } : {});

const TERMINAL: ReadonlySet<string> = new Set(["completed", "interrupted", "failed"]);

const findItem = (n: ThreadSnapshot, runId: string, itemId: string) =>
  n.items.findIndex((i) => i.runId === runId && i.itemId === itemId);

function insertItem(n: ThreadSnapshot, seq: number, ts: number, i: Omit<ThreadItem, "seq" | "ts">) {
  const it: ThreadItem = { seq, runId: i.runId, itemId: i.itemId, kind: i.kind, text: i.text, ts };
  if (i.tool !== undefined) it.tool = i.tool;
  if (i.input !== undefined) it.input = i.input;
  if (i.output !== undefined) it.output = i.output;
  if (i.isError !== undefined) it.isError = i.isError;
  if (i.status !== undefined) it.status = i.status;
  if (i.attachments !== undefined) it.attachments = i.attachments;
  n.items.push(it);
}

function insertRun(n: ThreadSnapshot, runId: string, r: Pick<RunRow, "origin" | "status" | "nativeThreadId" | "model" | "queuedAt" | "startedAt">) {
  if (n.runs.some((x) => x.runId === runId)) return; // INSERT OR IGNORE
  n.runs.push({ runId, ...r, harness: n.native?.harness ?? null, endedAt: null, endedSeq: null, usage: null, error: null });
}

function terminal(n: ThreadSnapshot, seq: number, ts: number, runId: string, status: RunRow["status"],
  f: { nativeThreadId?: string; usage?: RunRow["usage"]; error: string | null; failureReason?: RunRow["failureReason"] }, setUsage = false) {
  const idx = n.runs.findIndex((r) => r.runId === runId);
  if (idx < 0) {
    insertItem(n, seq, ts, { runId, itemId: null, kind: "notice", text: `${status} event for unknown run ${runId}`, status: "done" });
    return;
  }
  const { failureReason: _, ...r } = n.runs[idx];
  n.runs[idx] = {
    ...r, status, endedAt: ts, endedSeq: seq, error: f.error,
    nativeThreadId: f.nativeThreadId ?? r.nativeThreadId,
    usage: setUsage ? (f.usage ?? null) : r.usage,
    ...(f.failureReason ? { failureReason: f.failureReason } : {}),
  };
  n.items = n.items.map((i) => (i.runId === runId && i.status === "streaming" ? { ...i, status: "done" } : i));
}

function dispatch(n: ThreadSnapshot, { seq, ts, event: ev }: LoggedEvent) {
  switch (ev.type) {
    case "thread.native":
      // A resumed Claude thread is announced before the CLI names its model: null keeps the harness's known one (as in ThreadStore).
      n.native = { harness: ev.harness, nativeThreadId: ev.nativeThreadId, account: ev.account, model: ev.model ?? (n.native?.harness === ev.harness ? n.native.model : null) };
      return;
    case "run.queued":
      insertRun(n, ev.runId, { origin: ev.origin ?? "user", status: "queued", nativeThreadId: null, model: null, queuedAt: ts, startedAt: null });
      insertItem(n, seq, ts, { runId: ev.runId, itemId: `user:${ev.runId}`, kind: "user", text: ev.text, status: "done", ...withAttachments(ev.attachments) });
      return;
    case "run.started": {
      const idx = n.runs.findIndex((r) => r.runId === ev.runId);
      if (idx < 0) insertRun(n, ev.runId, { origin: ev.origin, status: "running", nativeThreadId: ev.nativeThreadId, model: ev.model, queuedAt: null, startedAt: ts });
      else if (n.runs[idx].status === "queued") {
        n.runs[idx] = { ...n.runs[idx], origin: ev.origin, status: "running", nativeThreadId: ev.nativeThreadId, model: ev.model, startedAt: ts };
      }
      // A start for a run that already ended or runs is a replay artefact: do not regress it.
      return;
    }
    case "message.delta": {
      // The harness may keep streaming after an interrupt until its result: the run is over, the item stays done.
      if (n.runs.some((r) => r.runId === ev.runId && TERMINAL.has(r.status))) return;
      const idx = findItem(n, ev.runId, ev.itemId);
      if (idx < 0) insertItem(n, seq, ts, { runId: ev.runId, itemId: ev.itemId, kind: "assistant", text: ev.text, status: "streaming" });
      else n.items[idx] = { ...n.items[idx], text: n.items[idx].text + ev.text, status: "streaming" };
      return;
    }
    case "message.final": {
      if (ev.role === "user") {
        // The user's text already came with run.queued; a harness echo must not duplicate it.
        if (!n.items.some((i) => i.runId === ev.runId && i.kind === "user")) {
          insertItem(n, seq, ts, { runId: ev.runId, itemId: ev.itemId, kind: "user", text: ev.text, status: "done", ...withAttachments(ev.attachments) });
        }
        return;
      }
      const idx = findItem(n, ev.runId, ev.itemId);
      if (idx < 0) insertItem(n, seq, ts, { runId: ev.runId, itemId: ev.itemId, kind: "assistant", text: ev.text, status: "done" });
      else n.items[idx] = { ...n.items[idx], text: ev.text, status: "done" };
      return;
    }
    case "tool.started":
      if (findItem(n, ev.runId, ev.itemId) >= 0) return; // re-announcement
      insertItem(n, seq, ts, { runId: ev.runId, itemId: ev.itemId, kind: "tool", text: "", tool: ev.tool, input: ev.input, status: "streaming" });
      return;
    case "tool.finished": {
      const idx = findItem(n, ev.runId, ev.itemId);
      if (idx < 0) {
        // The start was trimmed from the log: show the result, marked as an unknown tool.
        insertItem(n, seq, ts, { runId: ev.runId, itemId: ev.itemId, kind: "tool", text: "", tool: "(unknown)", output: ev.output, isError: ev.isError, status: "done" });
      } else {
        n.items[idx] = { ...n.items[idx], output: ev.output, isError: ev.isError, status: "done" };
      }
      return;
    }
    case "request.opened": {
      const known = n.pending.some((p) => p.requestId === ev.requestId)
        || n.items.some((i) => i.kind === "request" && i.itemId === ev.requestId);
      if (known) return; // re-announcement
      n.pending.push({
        requestId: ev.requestId, runId: ev.runId, kind: ev.kind, prompt: ev.prompt, openedAt: ts,
        ...(ev.options ? { options: ev.options } : {}),
        ...(ev.multiSelect !== undefined ? { multiSelect: ev.multiSelect } : {}),
      });
      insertItem(n, seq, ts, { runId: ev.runId, itemId: ev.requestId, kind: "request", text: ev.prompt, status: "open" });
      return;
    }
    case "request.resolved": {
      const status = ev.by === "expired" ? "expired" : "answered";
      n.pending = n.pending.filter((p) => p.requestId !== ev.requestId);
      n.items = n.items.map((i) => {
        if (i.kind !== "request" || i.itemId !== ev.requestId) return i;
        const next: ThreadItem = { ...i, status };
        if (ev.answer === null) delete next.output;
        else next.output = ev.answer;
        return next;
      });
      return;
    }
    case "background.changed":
      n.background = ev.work;
      return;
    case "run.completed":
      terminal(n, seq, ts, ev.runId, "completed", { nativeThreadId: ev.nativeThreadId, usage: ev.usage, error: null }, true);
      return;
    case "run.interrupted":
      terminal(n, seq, ts, ev.runId, "interrupted", { error: null });
      return;
    case "run.failed":
      // resume-failed or open-failed for a run id never announced is a switch's or the bridge start's: devd's own
      // notice says it (as in ThreadStore).
      if ((ev.error === "resume-failed" || ev.error === "open-failed") && !n.runs.some((r) => r.runId === ev.runId)) return;
      // Only known reasons, as in ThreadStore.
      terminal(n, seq, ts, ev.runId, "failed", { error: ev.error, failureReason: ev.reason === "rate-limited" ? ev.reason : undefined });
      insertItem(n, seq, ts, { runId: ev.runId, itemId: null, kind: "notice", text: ev.error, status: "done" });
      return;
    case "bridge.started":
      if (ev.resumed) insertItem(n, seq, ts, { runId: null, itemId: null, kind: "notice", text: `Agent bridge restarted (v${ev.version})`, status: "done" });
      if (ev.notice) insertItem(n, seq, ts, { runId: null, itemId: null, kind: "notice", text: ev.notice, status: "done" });
      return;
    case "bridge.notice":
      insertItem(n, seq, ts, { runId: null, itemId: null, kind: "notice", text: ev.text, status: "done" });
      return;
    case "effort.state":
    case "commands.changed":
      // devd never sends these as thread events (older apps would show them as unknown): see applyEffort.
      return;
    default: {
      const unknown: never = ev;
      const type = (unknown as { type?: unknown }).type;
      console.error(`thread view: unknown event type ${String(type)} at seq ${seq}`);
      insertItem(n, seq, ts, { runId: null, itemId: null, kind: "notice", text: `unknown event ${String(type)}`, status: "done" });
    }
  }
}

/** Merges the stream's `thread-snapshot` (see the `/api/stream` doc comment in devd/src/threadApi.ts): every item
 *  and run changed after `afterSeq` comes as a whole row that replaces the client's copy (items keyed by
 *  run + item id; items without an item id are never updated, so one in the snapshot is new); pending, background
 *  and native replace wholesale. */
export function mergeSnapshot(t: ThreadSnapshot, m: { afterSeq: number; snapshot: ThreadSnapshot }): ThreadSnapshot {
  const s = m.snapshot;
  const items = [...t.items];
  for (const it of s.items) {
    // An item without an item id never changes, so one at or below our seq is already here (a live frame got
    // ahead of the snapshot).
    if (it.itemId === null && it.seq <= t.lastSeq) continue;
    const idx = it.itemId === null ? -1 : items.findIndex((x) => x.runId === it.runId && x.itemId === it.itemId);
    if (idx >= 0) items[idx] = it;
    else items.push(it);
  }
  const runs = [...t.runs];
  for (const r of s.runs) {
    const idx = runs.findIndex((x) => x.runId === r.runId);
    if (idx >= 0) runs[idx] = r;
    else runs.push(r);
  }
  return { lastSeq: Math.max(t.lastSeq, s.lastSeq), seenSeq: s.seenSeq, items, runs, pending: s.pending, background: s.background, native: s.native, effort: s.effort };
}

/** The agent's effort from the stream (`thread-effort`, already parsed by devd's store). */
export function applyEffort(t: ThreadSnapshot, effort: ThreadEffort | null): ThreadSnapshot {
  return { ...t, effort };
}

/** A devd notice from the stream (`thread-notice`, devd's ThreadStore.addNotice): it has an item id `notice:<n>` and no
 *  seq of its own, so lastSeq stays; the same notice again (live and in a replay snapshot) is not added twice. */
export function applyNotice(t: ThreadSnapshot, item: ThreadItem): ThreadSnapshot {
  if (t.items.some((i) => i.itemId === item.itemId)) return t;
  return { ...t, items: [...t.items, item] };
}

/** The run the Stop button interrupts. */
export const activeRun = (t: ThreadSnapshot): RunRow | undefined => t.runs.find((r) => r.status === "running");

/** Runs waiting behind the active one: their user messages are shown as queued. */
export const queuedRunIds = (t: ThreadSnapshot): Set<string> =>
  new Set(t.runs.filter((r) => r.status === "queued").map((r) => r.runId));

/** Runs devd's critic started (its follow-up after a block): their user message is the critic's, not the user's. */
export const criticRunIds = (t: ThreadSnapshot): Set<string> =>
  new Set(t.runs.filter((r) => r.origin === "critic").map((r) => r.runId));

/** What the composer shows when sending failed. The text stays in the composer; nothing is retried: after a timeout
 *  the message may have been queued anyway. */
export function composerErrorText(status: number, body: unknown): string {
  const b = (typeof body === "object" && body !== null ? body : {}) as { error?: unknown; message?: unknown };
  if (b.error === "agent-disconnected") return "agent not connected — message not sent";
  if (b.error === "agent-timeout") return "no reply from the agent — check the thread before resending";
  if ((b.error === "command-failed" || b.error === "bridge-too-old") && typeof b.message === "string") return b.message;
  return typeof b.error === "string" ? b.error : `HTTP ${status}`;
}
