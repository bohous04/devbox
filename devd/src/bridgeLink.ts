import { SQLiteError } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { lstatSync, type Stats } from "node:fs";
import { join } from "node:path";
import type { Socket } from "bun";
import type { BridgeCommand, ClientFrame, ServerFrame } from "../../image/agent-bridge/src/protocol";
import { bridgeProof, proofMatches } from "../../image/agent-bridge/src/binding";
import { BRIDGE_VERSION } from "../../image/agent-bridge/src/version";
import { ACK_MIN_BRIDGE_VERSION, versionAtLeast } from "../../shared/bridgeVersion";
import type { LinkStatus, LoggedEvent } from "../../shared/thread";
import { CONTAINER_UID } from "./sshAgent";
import type { ThreadStore } from "./threadStore";

/** What a bridge says in each handshake (`ready`). `version` is null for a bridge older than switching (1.0.0 sent
 *  none); `awaitingTarget`: it holds no harness until devd sends switchTarget. */
export interface BridgeHandshake { version: string | null; awaitingTarget: boolean }

/** The bridge is not reachable (no socket, connection lost, link dropped). devd does not queue: the bridge owns the queue. */
export class AgentDisconnected extends Error {}
/** The bridge did not answer in time. A subclass because the caller cannot tell whether the command ran. */
export class CommandTimeout extends AgentDisconnected {}
/** The bridge answered `res{ok:false}`; the message is the bridge's. */
export class CommandFailed extends Error {}

const DEFAULT_TIMEOUT_MS = 10_000;
/** How often the same frame may fail at the same point of the thread before devd gives up on it (T9): an event is
 *  skipped with a notice, a frame without a seq is said once in the thread. */
export const POISON_LIMIT = 3;
/** How often a live link tells a bridge from ACK_MIN_BRIDGE_VERSION how far the store is durable (S6-R21); the
 *  bridge trims its log one such ack behind (S6-R19). */
export const ACK_INTERVAL_MS = 10 * 60_000;
/** SQLite errors of the store itself (full disk, I/O, locks): every event would fail, so none is skipped for them. */
const STORE_ERROR = /^SQLITE_(FULL|IOERR|BUSY|LOCKED|READONLY|CANTOPEN|NOMEM|CORRUPT|NOTADB|PROTOCOL|PERM|AUTH|INTERRUPT|ABORT)/;

/** DEVBOX-54: until when a chat session whose container predates the session binding (no secret stored) is still
 *  connected on the socket owner check alone. After it devd refuses such a link; ending and reopening the session
 *  creates a container with a secret. */
export const LEGACY_BRIDGE_UNTIL = Date.UTC(2026, 11, 4);

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** How long a bound connection may take to answer the hello with its `bind`. */
const BIND_TIMEOUT_MS = 10_000;
/** At most one refusal notification per session this often: a bridge flipping between refused and accepted must not
 *  turn into a stream of pushes. The thread notice and the log still say every episode. */
const REFUSED_NOTIFY_MS = 30 * 60_000;
/** What a session id looks like; anything else a bridge claims is not repeated to the log, thread or user. */
const SESSION_ID = /^[A-Za-z0-9._-]{1,64}$/;

/** devd's startup line about the sessions still on a legacy bridge; null when there are none. */
export function legacyBridgeStartupLine(ids: string[], until: number): string | null {
  if (ids.length === 0) return null;
  return `bridge binding: ${ids.length} chat sessions predate it (no bridge secret) and are connected only until ${day(until)}; end and reopen them before then: ${ids.join(", ")}`;
}

interface Pending { resolve: () => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }

interface Link {
  status: LinkStatus;
  socket: Socket<undefined> | null;
  buffer: string;
  decoder: TextDecoder;
  /** Encoded frames the socket did not accept yet; flushed on drain. */
  outbound: Buffer[];
  pending: Map<string, Pending>;
  retry: ReturnType<typeof setTimeout> | null;
  dropped: boolean;
  /** The current outage was logged; reset once a connection opens. */
  outageLogged: boolean;
  /** Since when the bridge's log is behind the store (its `ready.lastSeq` was below `store.lastSeq()`). */
  behindSince: number | null;
  /** The frame failure this link keeps hitting: the store's seq when it failed, the failure's key (failureKey), and
   *  how often it failed there. */
  failure: { atSeq: number; key: string; count: number } | null;
  /** The periodic ack of this connection; only for a bridge that takes it. */
  ackTimer: ReturnType<typeof setInterval> | null;
  /** A skipped ack was logged; reset (and the recovery logged) once an ack goes out again. */
  ackFailLogged: boolean;
  /** This connection's hello nonce while devd waits for the bridge's `bind`; nothing it sends is applied until then. */
  nonce: string | null;
  /** The secret this connection must be proven with (read at connect); null = legacy. */
  secret: string | null;
  /** The current refusal episode was said (log, thread); reset once a link is accepted. */
  refused: boolean;
  bindTimer: ReturnType<typeof setTimeout> | null;
}

class MalformedFrame extends Error {}

/** What makes two frame failures "the same" for the poison count: the error's class and SQLite code and the frame's
 *  seq, not the message — a message embedding varying text (a time, a counter) must still reach POISON_LIMIT. */
function failureKey(err: unknown, seq: number | null): string {
  const cls = err instanceof Error ? err.constructor.name : typeof err;
  const code = err instanceof SQLiteError ? err.code ?? "" : "";
  return `${cls}:${code}:${seq ?? "-"}`;
}

/** The integer `e.seq` of an event frame, also of one devd cannot use; null when the line has none. */
function eventSeq(line: string): number | null {
  try {
    const f = JSON.parse(line) as { t?: unknown; e?: { seq?: unknown } };
    return f.t === "event" && Number.isInteger(f.e?.seq) ? (f.e!.seq as number) : null;
  } catch { return null; }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseServerFrame(line: string): ServerFrame {
  let f: unknown;
  try { f = JSON.parse(line); } catch { throw new MalformedFrame("not valid JSON"); }
  if (!isRecord(f)) throw new MalformedFrame("not an object");
  switch (f.t) {
    case "event": {
      const e = f.e;
      if (!isRecord(e) || !Number.isInteger(e.seq) || typeof e.ts !== "number" || !isRecord(e.event) || typeof e.event.type !== "string") {
        throw new MalformedFrame("event without seq, ts or event.type");
      }
      return f as ServerFrame;
    }
    case "res":
      if (typeof f.id !== "string" || typeof f.ok !== "boolean") throw new MalformedFrame("res without id or ok");
      if (!f.ok && typeof f.error !== "string") throw new MalformedFrame("failed res without an error message");
      return f as ServerFrame;
    case "bind":
      if (typeof f.session !== "string" || typeof f.proof !== "string") throw new MalformedFrame("bind without session or proof");
      return f as ServerFrame;
    case "ready":
      if (!Number.isInteger(f.lastSeq)) throw new MalformedFrame("ready without lastSeq");
      if (f.version !== undefined && typeof f.version !== "string") throw new MalformedFrame("ready with a non-string version");
      if (f.awaitingTarget !== undefined && typeof f.awaitingTarget !== "boolean") throw new MalformedFrame("ready with a non-boolean awaitingTarget");
      return f as ServerFrame;
    default:
      // The type is repeated (log, thread notice) only when it looks like one: a bridge's text must not forge lines.
      throw new MalformedFrame(typeof f.t === "string" && /^[a-z_]{1,16}$/.test(f.t) ? `unknown frame type ${f.t}` : "unknown frame type");
  }
}

/** devd's side of each chat session's `<controlDir>/agent.sock` (mounted as /run/devd in the container).
 *  Every event is applied to the session's thread store before `onEvent` sees it; a reconnect says
 *  `hello{afterSeq: store.lastSeq()}`, so the bridge replays only what the store is missing. */
/** startTurnWhenConnected refused: the session already has a first message waiting (it is never replaced). */
export class FirstTurnPending extends Error {
  constructor(message: string) { super(message); this.name = "FirstTurnPending"; }
}

/** The persisted tag of a user's first prompt (POST /api/sessions), so its outcome is reported after a devd restart
 *  too. Other tags are schedule names; the control character keeps a schedule's name from ever being taken for it. */
export const USER_FIRST_PROMPT_TAG = "\u0001user-first-prompt";

export class BridgeLinks {
  private links = new Map<string, Link>();
  /** devd's own first message per session (startTurnWhenConnected), until the bridge took it. */
  private firstTurns = new Map<string, string>();
  private firstTurnDone = new Map<string, (err: Error | null) => void>();
  private legacyLogged = new Set<string>();
  private refusedNotifiedAt = new Map<string, number>();
  private bindTimeoutMs: number;
  private now: () => number;
  private retryMs: number;
  private ackMs: number;
  private log: (msg: string) => void;

  constructor(private d: {
    /** DEVBOX-54: binds each link to its session (see LEGACY_BRIDGE_UNTIL). */
    binding: {
      /** The secret stored for the session's current container; null = created before the binding. */
      secret: (id: string) => string | null;
      legacyUntil: number;
      /** devd refused the session's bridge and the user has to act; once per episode, with the thread notice's text. */
      onRefused: (id: string, text: string) => void;
    };
    now?: () => number;
    /** Default BIND_TIMEOUT_MS. */
    bindTimeoutMs?: number;
    controlDir: (id: string) => string;
    store: (id: string) => ThreadStore;
    onEvent: (sessionId: string, e: LoggedEvent) => void;
    onStatus: (sessionId: string, s: LinkStatus) => void;
    /** `behind(sessionId)` changed. */
    onBehind: (sessionId: string) => void;
    /** Every handshake, after the replayed events were applied. */
    onHandshake?: (sessionId: string, h: BridgeHandshake) => void;
    /** Where devd's first message survives a devd restart (main DB); without it the message is memory only. */
    pendingTurns?: {
      save: (id: string, text: string, seq: number, tag: string | null) => void;
      load: (id: string) => { text: string; seq: number; tag: string | null } | null;
      remove: (id: string) => void;
    };
    /** Outcome of a first message that was loaded from `pendingTurns` after a restart and carries a tag
     *  (the schedule name): there is no caller left to hear it. */
    onRestoredTurnDone?: (sessionId: string, tag: string, err: Error | null) => void;
    retryMs?: number;
    /** Owner agent.sock must have. Default: the container user (uid 1000) when devd is root, else
     *  devd's own uid (tests, dev machines). */
    socketUid?: number;
    /** Default ACK_INTERVAL_MS. */
    ackMs?: number;
    log?: (msg: string) => void;
  }) {
    this.retryMs = d.retryMs ?? 2000;
    this.ackMs = d.ackMs ?? ACK_INTERVAL_MS;
    this.bindTimeoutMs = d.bindTimeoutMs ?? BIND_TIMEOUT_MS;
    this.now = d.now ?? Date.now;
    this.log = d.log ?? ((msg) => console.error(msg));
  }

  /** Keeps a link to the session's bridge, reconnecting every `retryMs` until `drop`. Idempotent. */
  ensure(sessionId: string): void {
    if (this.links.has(sessionId)) return;
    // A first message persisted before a restart is delivered on this link's first connection.
    if (!this.firstTurns.has(sessionId)) {
      const saved = this.d.pendingTurns?.load(sessionId);
      if (saved) {
        // The bridge may have accepted the turn just before devd died, leaving the row behind: a run started after
        // the row was saved means it was delivered. Runs from before (a reused session) say nothing.
        if (this.d.store(sessionId).snapshot({ afterSeq: saved.seq, limit: 0 }).runs.length > 0) {
          this.d.pendingTurns?.remove(sessionId);
          this.log(`bridge link ${sessionId}: dropped a persisted first message, the thread already has a run since it was queued`);
        } else {
          this.firstTurns.set(sessionId, saved.text);
          const { tag } = saved;
          if (tag !== null && this.d.onRestoredTurnDone) this.firstTurnDone.set(sessionId, (err) => this.d.onRestoredTurnDone!(sessionId, tag, err));
        }
      }
    }
    const link: Link = {
      status: "connecting", socket: null, buffer: "", decoder: new TextDecoder(), outbound: [],
      pending: new Map(), retry: null, dropped: false, outageLogged: false, behindSince: null, failure: null, ackFailLogged: false,
      ackTimer: null, nonce: null, secret: null, refused: false, bindTimer: null,
    };
    this.links.set(sessionId, link);
    this.notifyStatus(sessionId, "connecting");
    this.connect(sessionId, link);
  }

  /** Stops retrying and closes the socket. Commands in flight fail with AgentDisconnected. No status callback:
   *  dropping is the owner's decision (stop/end), not something the link observed. */
  drop(sessionId: string): void {
    if (this.discardFirstTurn(sessionId)) this.log(`bridge link ${sessionId}: dropped before devd's first message was sent; it is discarded`);
    const link = this.links.get(sessionId);
    if (!link) return;
    this.links.delete(sessionId);
    link.dropped = true;
    if (link.retry) clearTimeout(link.retry);
    this.endBindWait(link);
    this.stopAcks(link);
    link.socket?.end();
    link.socket = null;
    this.failPending(link, "link dropped");
  }

  /** The session ended: a later session that reuses the id starts without its refusal rate limit. */
  forget(sessionId: string): void {
    this.refusedNotifiedAt.delete(sessionId);
  }

  status(sessionId: string): LinkStatus {
    return this.links.get(sessionId)?.status ?? "disconnected";
  }

  /** Since when the bridge's event log has been behind the thread store, or null. While it is, the bridge reuses
   *  seqs the store already holds, and the store drops those events as duplicates. */
  behind(sessionId: string): number | null {
    return this.links.get(sessionId)?.behindSince ?? null;
  }

  send(sessionId: string, cmd: BridgeCommand, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<void> {
    const link = this.links.get(sessionId);
    if (!link || link.status !== "connected" || !link.socket) {
      return Promise.reject(new AgentDisconnected(`agent bridge of ${sessionId} is not connected`));
    }
    const id = crypto.randomUUID();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        link.pending.delete(id);
        reject(new CommandTimeout(`agent bridge of ${sessionId} did not answer ${cmd.kind} within ${timeoutMs} ms`));
      }, timeoutMs);
      link.pending.set(id, { resolve, reject, timer });
      this.write(link, { t: "cmd", id, cmd });
    });
  }

  /** Sends `text` as a startTurn once the link is connected (at once if it is). For devd's own first message
   *  of a session (a pull conflict on open, a scheduled run's prompt). Not sent because the bridge was unreachable:
   *  tried again on the next connection, also after a devd restart (persisted until the bridge answered). Timed out
   *  (outcome unknown) or refused: logged, never resent. `onDone` hears the outcome once: null = the bridge accepted
   *  the turn, an Error = it was refused, timed out, discarded or dropped. It is memory only; `tag` is persisted
   *  and reaches `onRestoredTurnDone` instead after a restart. */
  startTurnWhenConnected(sessionId: string, text: string, onDone?: (err: Error | null) => void, tag: string | null = null): void {
    // One first message per session: a second (a scheduled run's) must not replace one still waiting (the user's).
    if (this.hasFirstTurn(sessionId)) throw new FirstTurnPending(`${sessionId} already has a first message waiting to be sent`);
    this.d.pendingTurns?.save(sessionId, text, this.d.store(sessionId).lastSeq(), tag);
    this.firstTurns.set(sessionId, text);
    if (onDone) this.firstTurnDone.set(sessionId, onDone);
    if (this.status(sessionId) === "connected") this.sendFirstTurn(sessionId);
  }

  /** Whether a first message is waiting for this session (in memory or persisted): a second one would replace it. */
  hasFirstTurn(sessionId: string): boolean {
    return this.firstTurns.has(sessionId) || (this.d.pendingTurns?.load(sessionId) ?? null) !== null;
  }

  /** Forgets a first message that was not sent yet (memory and DB). True when there was one; false when it was
   *  already sent (or never queued), so the caller can tell a late discard from an effective one. */
  discardFirstTurn(sessionId: string): boolean {
    this.d.pendingTurns?.remove(sessionId);
    const had = this.firstTurns.delete(sessionId);
    if (had) this.settleFirstTurn(sessionId, new Error("first message discarded before it was sent"));
    return had;
  }

  private settleFirstTurn(sessionId: string, err: Error | null) {
    const done = this.firstTurnDone.get(sessionId);
    if (!done) return;
    this.firstTurnDone.delete(sessionId);
    done(err);
  }

  private sendFirstTurn(sessionId: string) {
    const text = this.firstTurns.get(sessionId);
    if (text === undefined) return;
    this.firstTurns.delete(sessionId);
    this.send(sessionId, { kind: "startTurn", text }).then(() => {
      this.d.pendingTurns?.remove(sessionId);
      this.settleFirstTurn(sessionId, null);
    }, (err: Error) => {
      if (err instanceof AgentDisconnected && !(err instanceof CommandTimeout) && this.links.has(sessionId)) {
        this.firstTurns.set(sessionId, text);
        this.log(`bridge link ${sessionId}: devd's first message not sent (${err.message}); retrying on the next connection`);
        return;
      }
      this.d.pendingTurns?.remove(sessionId);
      this.log(`bridge link ${sessionId}: devd's first message failed, not resent: ${err.message}`);
      this.settleFirstTurn(sessionId, err);
    });
  }

  private setStatus(sessionId: string, link: Link, s: LinkStatus) {
    if (link.status === s) return;
    link.status = s;
    this.notifyStatus(sessionId, s);
  }

  /** Runs inside socket callbacks: a throw (e.g. a store read) must not escape, the link carries on. */
  private notifyStatus(sessionId: string, s: LinkStatus) {
    try { this.d.onStatus(sessionId, s); }
    catch (err) { this.log(`bridge link ${sessionId}: onStatus failed for ${s}: ${err instanceof Error ? err.message : String(err)}`); }
  }

  private write(link: Link, f: ClientFrame) {
    link.outbound.push(Buffer.from(JSON.stringify(f) + "\n"));
    this.flush(link);
  }

  private flush(link: Link) {
    const socket = link.socket;
    if (!socket) return;
    while (link.outbound.length) {
      const frame = link.outbound[0];
      const n = Math.max(socket.write(frame), 0);
      if (n < frame.length) {
        link.outbound[0] = frame.subarray(n);
        return;
      }
      link.outbound.shift();
    }
  }

  private failPending(link: Link, why: string) {
    for (const p of link.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new AgentDisconnected(why));
    }
    link.pending.clear();
  }

  private connect(sessionId: string, link: Link) {
    link.retry = null;
    const path = join(this.d.controlDir(sessionId), "agent.sock");
    // The control dir is agent-writable (/run/devd) and devd connects as root: a planted symlink
    // would point devd at any socket on the host. Only a real socket owned by the container user is
    // accepted (lstat does not follow links). A swap between this check and the connect is caught by the session
    // binding: a bridge must prove the session's secret before devd applies anything (legacy sessions aside).
    try { link.secret = this.d.binding.secret(sessionId); }
    catch (err) { this.down(sessionId, link, `cannot read the session's bridge secret: ${err instanceof Error ? err.message : String(err)}`); return; }
    if (link.secret === null) {
      const until = this.d.binding.legacyUntil;
      if (this.now() >= until) {
        this.refuse(sessionId, link, `devd no longer connects to the agent bridge of ${sessionId}: its container predates the session binding, which devd accepted until ${day(until)}. To continue, end and reopen the session (the new container's bridge can prove its session).`);
        return;
      }
      if (!this.legacyLogged.has(sessionId)) {
        this.legacyLogged.add(sessionId);
        this.log(`bridge link ${sessionId}: legacy bridge without a session secret (its container predates the session binding): only the socket owner is checked, until ${day(until)}`);
      }
    }
    const sockUid = this.d.socketUid ?? (process.getuid?.() === 0 ? CONTAINER_UID : process.getuid?.());
    let st: Stats;
    // Nothing there yet (bridge not started): no connect at all — a connect would resolve whatever
    // appears between this lstat and it, unchecked. The next retry checks again.
    try { st = lstatSync(path); } catch { this.down(sessionId, link, `no socket yet at ${path}`); return; }
    if (!st.isSocket() || st.uid !== sockUid) {
      this.down(sessionId, link, `refusing ${path}: not a socket owned by uid ${sockUid}`);
      return;
    }
    Bun.connect({
      unix: path,
      socket: {
        open: (s) => this.onOpen(sessionId, link, s),
        // Callbacks of an earlier connection must not touch the current one.
        data: (s, chunk) => { if (s === link.socket) this.onData(sessionId, link, chunk); },
        drain: (s) => { if (s === link.socket) this.flush(link); },
        close: (s) => { if (s === link.socket) this.onClose(sessionId, link, "connection closed"); },
        error: (_s, err) => this.log(`bridge link ${sessionId}: socket error: ${err.message}`),
      },
    }).catch((err: Error) => this.down(sessionId, link, `cannot connect to ${path}: ${err.message}`));
  }

  private onOpen(sessionId: string, link: Link, socket: Socket<undefined>) {
    if (link.dropped) { socket.end(); return; }
    let afterSeq: number;
    try { afterSeq = this.d.store(sessionId).lastSeq(); }
    catch (err) {
      socket.end();
      this.down(sessionId, link, `cannot read the thread store: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    link.socket = socket;
    link.buffer = "";
    link.decoder = new TextDecoder();
    link.outbound = [];
    if (link.secret !== null) {
      // Connected only once the bridge's `bind` proved the session (onData); until then nothing is sent or applied.
      link.nonce = randomBytes(16).toString("hex");
      // `session`: a bound bridge of another session drops this hello before it acks or replays anything.
      this.write(link, { t: "hello", afterSeq, nonce: link.nonce, session: sessionId });
      link.bindTimer = setTimeout(() => {
        link.bindTimer = null;
        if (link.socket === socket && link.nonce !== null) {
          this.refuse(sessionId, link, `devd refused the agent bridge of ${sessionId}: the agent bridge did not prove its session within ${this.bindTimeoutMs / 1000} s. devd keeps retrying; if this stays, end and reopen the session.`);
        }
      }, this.bindTimeoutMs);
      return;
    }
    this.accepted(sessionId, link);
    this.write(link, { t: "hello", afterSeq, session: sessionId });
    this.setStatus(sessionId, link, "connected");
    this.sendFirstTurn(sessionId);
  }

  /** The connection is this session's bridge (bound, or legacy within the window). */
  private accepted(sessionId: string, link: Link) {
    if (link.outageLogged) this.log(`bridge link ${sessionId}: reconnected`);
    link.outageLogged = false;
    link.refused = false;
  }

  /** The first frame of a connection that must be bound: its `bind`, or a refusal. True when the link is bound. */
  private checkBind(sessionId: string, link: Link, f: ServerFrame): boolean {
    const nonce = link.nonce!;
    let why: string | null = null;
    if (f.t !== "bind") why = `the agent bridge did not prove its session (its first frame was "${f.t}"): its container may predate the session binding, or the socket is not this session's bridge`;
    else if (f.session !== sessionId) {
      why = SESSION_ID.test(f.session)
        ? `the socket leads to the agent bridge of another session (${f.session})`
        : "the socket leads to the agent bridge of another session: it names no valid session id";
    }
    else if (!proofMatches(bridgeProof(link.secret!, nonce, sessionId), f.proof)) why = "the agent bridge's proof does not match this session's secret";
    if (why !== null) {
      this.refuse(sessionId, link, `devd refused the agent bridge of ${sessionId}: ${why}. devd keeps retrying; if this stays, end and reopen the session.`);
      return false;
    }
    this.endBindWait(link);
    this.accepted(sessionId, link);
    this.setStatus(sessionId, link, "connected");
    this.sendFirstTurn(sessionId);
    return true;
  }

  private endBindWait(link: Link) {
    link.nonce = null;
    if (link.bindTimer) clearTimeout(link.bindTimer);
    link.bindTimer = null;
  }

  /** Closes the connection (if any) and retries; said once per episode in the log, the thread and to the user. */
  private refuse(sessionId: string, link: Link, text: string) {
    if (!link.refused) {
      link.refused = true;
      this.log(`bridge link ${sessionId}: refused: ${text}`);
      try { this.d.store(sessionId).addNotice(text, Date.now()); }
      catch (e) { this.log(`bridge link ${sessionId}: cannot add a notice: ${e instanceof Error ? e.message : String(e)}`); }
      const last = this.refusedNotifiedAt.get(sessionId);
      if (last === undefined || this.now() - last >= REFUSED_NOTIFY_MS) {
        this.refusedNotifiedAt.set(sessionId, this.now());
        try { this.d.binding.onRefused(sessionId, text); }
        catch (e) { this.log(`bridge link ${sessionId}: onRefused failed: ${e instanceof Error ? e.message : String(e)}`); }
      }
    }
    this.endBindWait(link);
    const socket = link.socket;
    if (socket) {
      // Detach first: end() may call the close callback synchronously, and it must not run onClose twice.
      this.onClose(sessionId, link, "refused", true);
      socket.end();
    } else {
      this.down(sessionId, link, "refused", true);
    }
  }

  /** `quiet`: a repeat of a failure already logged; neither this outage nor its reconnect is logged again. */
  private onClose(sessionId: string, link: Link, why: string, quiet = false) {
    if (link.dropped) return;
    link.socket = null;
    this.endBindWait(link);
    this.stopAcks(link);
    this.failPending(link, why);
    this.down(sessionId, link, why, quiet);
  }

  private down(sessionId: string, link: Link, why: string, quiet = false) {
    if (link.dropped) return;
    if (!link.outageLogged && !quiet) {
      this.log(`bridge link ${sessionId}: disconnected (${why}); retrying every ${this.retryMs} ms`);
      link.outageLogged = true;
    }
    this.setStatus(sessionId, link, "disconnected");
    link.retry = setTimeout(() => this.connect(sessionId, link), this.retryMs);
  }

  private onData(sessionId: string, link: Link, chunk: Buffer) {
    link.buffer += link.decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = link.buffer.indexOf("\n")) >= 0) {
      const line = link.buffer.slice(0, nl);
      link.buffer = link.buffer.slice(nl + 1);
      if (!line) continue;
      try {
        const f = parseServerFrame(line);
        if (link.nonce !== null) {
          if (!this.checkBind(sessionId, link, f)) return;
          continue;
        }
        this.handle(sessionId, link, f);
      } catch (err) {
        // Before the bind nothing is this session's yet: no poison counting, no skipped event, just a refusal.
        if (link.nonce !== null) {
          this.refuse(sessionId, link, `devd refused the agent bridge of ${sessionId}: the agent bridge did not prove its session (its first frame was malformed). devd keeps retrying; if this stays, end and reopen the session.`);
          return;
        }
        // A malformed frame or a store write error: drop this connection (onClose logs why); the reconnect's
        // hello carries the stored seq, so nothing is lost or applied twice.
        const what = err instanceof MalformedFrame ? `malformed frame: ${err.message}` : `cannot apply frame: ${err instanceof Error ? err.message : String(err)}`;
        const repeats = this.failed(sessionId, link, err, what, eventSeq(line));
        if (repeats === null) continue; // skipped
        const socket = link.socket;
        // Detach first: end() may call the close callback synchronously, and it must not run onClose twice.
        this.onClose(sessionId, link, what, repeats > 1);
        socket?.end();
        return;
      }
    }
  }

  /** Counts a frame failure at the store's current seq (T9: the bridge replays the same frame after every reconnect).
   *  At POISON_LIMIT identical failures an event the store cannot take is skipped with a notice (returns null: carry
   *  on with the next frame); a frame without a seq is said once in the thread; a store that cannot write at all is
   *  logged once and never skipped past. Otherwise returns how often it failed. */
  private failed(sessionId: string, link: Link, err: unknown, what: string, seq: number | null): number | null {
    let atSeq: number;
    try { atSeq = this.d.store(sessionId).lastSeq(); }
    catch { return 1; } // no store to count against: plain drop and reconnect, logged by down()
    const key = failureKey(err, seq);
    const f = link.failure?.atSeq === atSeq && link.failure.key === key ? link.failure : { atSeq, key, count: 0 };
    link.failure = f;
    f.count++;
    if (f.count < POISON_LIMIT) return f.count;
    if (err instanceof SQLiteError && STORE_ERROR.test(err.code ?? "")) {
      if (f.count === POISON_LIMIT) this.log(`bridge link ${sessionId}: the thread store cannot take events (${what}); retrying every ${this.retryMs} ms`);
      return f.count;
    }
    if (seq !== null && seq > atSeq) {
      try {
        this.d.store(sessionId).skipEvent(seq, `devd skipped event ${seq} from the agent bridge after ${f.count} failed attempts: ${what}`, Date.now());
      } catch (e) {
        if (f.count === POISON_LIMIT) this.log(`bridge link ${sessionId}: cannot skip event ${seq}: ${e instanceof Error ? e.message : String(e)}`);
        return f.count;
      }
      this.log(`bridge link ${sessionId}: skipped event ${seq} after ${f.count} failed attempts: ${what}`);
      link.failure = null;
      return null;
    }
    if (f.count === POISON_LIMIT) {
      const text = `the agent bridge keeps sending a frame devd cannot read (${what}); the link reconnects every ${this.retryMs} ms`;
      this.log(`bridge link ${sessionId}: ${text}`);
      try { this.d.store(sessionId).addNotice(text, Date.now()); }
      catch (e) { this.log(`bridge link ${sessionId}: cannot add a notice: ${e instanceof Error ? e.message : String(e)}`); }
    }
    return f.count;
  }

  private handle(sessionId: string, link: Link, f: ServerFrame) {
    switch (f.t) {
      case "event":
        if (!this.d.store(sessionId).apply(f.e)) return;
        if (link.failure !== null && f.e.seq > link.failure.atSeq) link.failure = null; // past the failing point
        try { this.d.onEvent(sessionId, f.e); }
        catch (err) { this.log(`bridge link ${sessionId}: onEvent failed for seq ${f.e.seq}: ${err instanceof Error ? err.message : String(err)}`); }
        return;
      case "res": {
        const p = link.pending.get(f.id);
        if (!p) {
          this.log(`bridge link ${sessionId}: response for unknown or timed-out command ${f.id}`);
          return;
        }
        link.pending.delete(f.id);
        clearTimeout(p.timer);
        if (f.ok) p.resolve();
        else p.reject(new CommandFailed(f.error));
        return;
      }
      case "bind": return; // only the first frame of a bound connection means anything (checkBind)
      case "ready":
        this.checkBehind(sessionId, link, f.lastSeq);
        this.checkVersion(sessionId, f.version ?? null);
        this.stopAcks(link);
        if (f.version !== undefined && versionAtLeast(f.version, ACK_MIN_BRIDGE_VERSION)) {
          link.ackTimer = setInterval(() => this.sendAck(sessionId, link), this.ackMs);
        }
        try { this.d.onHandshake?.(sessionId, { version: f.version ?? null, awaitingTarget: f.awaitingTarget === true }); }
        catch (err) { this.log(`bridge link ${sessionId}: onHandshake failed: ${err instanceof Error ? err.message : String(err)}`); }
        return;
    }
  }

  private stopAcks(link: Link) {
    if (link.ackTimer) clearInterval(link.ackTimer);
    link.ackTimer = null;
  }

  /** S6-R21: tells the bridge the store holds every event up to its durable seq. Not durable now (a checkpoint
   *  that could not finish) or no store: logged once per episode (like checkBehind), and the next interval tries
   *  again. */
  private sendAck(sessionId: string, link: Link) {
    if (link.status !== "connected" || !link.socket) return;
    const skipped = (why: string) => {
      if (!link.ackFailLogged) this.log(`bridge link ${sessionId}: no ack: ${why}`);
      link.ackFailLogged = true;
    };
    let seq: number | null;
    try { seq = this.d.store(sessionId).durableSeq(); }
    catch (err) { skipped(err instanceof Error ? err.message : String(err)); return; }
    if (seq === null) { skipped("the thread store's checkpoint could not finish (another reader holds the WAL)"); return; }
    this.write(link, { t: "ack", seq });
    if (link.ackFailLogged) this.log(`bridge link ${sessionId}: acks resumed (seq ${seq})`);
    link.ackFailLogged = false;
  }

  /** M12: a bridge older than the one this devd ships keeps running until its container is recreated. Said once per
   *  session and version, in the thread and the log. */
  private checkVersion(sessionId: string, version: string | null) {
    if (version !== null && versionAtLeast(version, BRIDGE_VERSION)) return;
    const text = `this session's agent bridge is ${version ?? "older than 1.1.0"}, older than the current ${BRIDGE_VERSION}: it lacks the newer fixes until the session's container is recreated`;
    if (this.d.store(sessionId).addNoticeOnce(`older-bridge:${version ?? "unknown"}`, text, Date.now())) this.log(`bridge link ${sessionId}: ${text}`);
  }

  /** A host crash can lose the unsynced tail of the bridge's log after devd stored it. Detection only: the link
   *  carries on, the thread gets a notice and the inbox shows the session as needing the user. */
  private checkBehind(sessionId: string, link: Link, bridgeSeq: number) {
    const store = this.d.store(sessionId);
    const storeSeq = store.lastSeq();
    if (bridgeSeq >= storeSeq) {
      if (link.behindSince === null) return;
      link.behindSince = null;
      this.log(`bridge link ${sessionId}: bridge log caught up with devd's store (bridge ${bridgeSeq}, devd ${storeSeq})`);
    } else {
      // Once per episode: a reconnect while still behind says nothing new.
      if (link.behindSince !== null) return;
      const text = `bridge log is behind devd's store (bridge ${bridgeSeq}, devd ${storeSeq}); new events may be missing`;
      this.log(`bridge link ${sessionId}: ${text}`);
      store.addNotice(text, Date.now());
      link.behindSince = Date.now();
    }
    try { this.d.onBehind(sessionId); }
    catch (err) { this.log(`bridge link ${sessionId}: onBehind failed: ${err instanceof Error ? err.message : String(err)}`); }
  }
}
