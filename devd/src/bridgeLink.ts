import { join } from "node:path";
import type { Socket } from "bun";
import type { BridgeCommand, ClientFrame, ServerFrame } from "../../image/agent-bridge/src/protocol";
import type { LinkStatus, LoggedEvent } from "../../shared/thread";
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
}

class MalformedFrame extends Error {}

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
    case "ready":
      if (!Number.isInteger(f.lastSeq)) throw new MalformedFrame("ready without lastSeq");
      if (f.version !== undefined && typeof f.version !== "string") throw new MalformedFrame("ready with a non-string version");
      if (f.awaitingTarget !== undefined && typeof f.awaitingTarget !== "boolean") throw new MalformedFrame("ready with a non-boolean awaitingTarget");
      return f as ServerFrame;
    default:
      throw new MalformedFrame(`unknown frame type ${String(f.t)}`);
  }
}

/** devd's side of each chat session's `<controlDir>/agent.sock` (mounted as /run/devd in the container).
 *  Every event is applied to the session's thread store before `onEvent` sees it; a reconnect says
 *  `hello{afterSeq: store.lastSeq()}`, so the bridge replays only what the store is missing. */
export class BridgeLinks {
  private links = new Map<string, Link>();
  /** devd's own first message per session (startTurnWhenConnected), until the bridge took it. */
  private firstTurns = new Map<string, string>();
  private retryMs: number;
  private log: (msg: string) => void;

  constructor(private d: {
    controlDir: (id: string) => string;
    store: (id: string) => ThreadStore;
    onEvent: (sessionId: string, e: LoggedEvent) => void;
    onStatus: (sessionId: string, s: LinkStatus) => void;
    /** `behind(sessionId)` changed. */
    onBehind: (sessionId: string) => void;
    /** Every handshake, after the replayed events were applied. */
    onHandshake?: (sessionId: string, h: BridgeHandshake) => void;
    retryMs?: number;
    log?: (msg: string) => void;
  }) {
    this.retryMs = d.retryMs ?? 2000;
    this.log = d.log ?? ((msg) => console.error(msg));
  }

  /** Keeps a link to the session's bridge, reconnecting every `retryMs` until `drop`. Idempotent. */
  ensure(sessionId: string): void {
    if (this.links.has(sessionId)) return;
    const link: Link = {
      status: "connecting", socket: null, buffer: "", decoder: new TextDecoder(), outbound: [],
      pending: new Map(), retry: null, dropped: false, outageLogged: false, behindSince: null,
    };
    this.links.set(sessionId, link);
    this.notifyStatus(sessionId, "connecting");
    this.connect(sessionId, link);
  }

  /** Stops retrying and closes the socket. Commands in flight fail with AgentDisconnected. No status callback:
   *  dropping is the owner's decision (stop/end), not something the link observed. */
  drop(sessionId: string): void {
    if (this.firstTurns.delete(sessionId)) this.log(`bridge link ${sessionId}: dropped before devd's first message was sent; it is discarded`);
    const link = this.links.get(sessionId);
    if (!link) return;
    this.links.delete(sessionId);
    link.dropped = true;
    if (link.retry) clearTimeout(link.retry);
    link.socket?.end();
    link.socket = null;
    this.failPending(link, "link dropped");
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
   *  of a session (a pull conflict on open). Not sent because the bridge was unreachable: tried again on the next
   *  connection. Timed out (outcome unknown) or refused: logged, never resent. */
  startTurnWhenConnected(sessionId: string, text: string): void {
    this.firstTurns.set(sessionId, text);
    if (this.status(sessionId) === "connected") this.sendFirstTurn(sessionId);
  }

  private sendFirstTurn(sessionId: string) {
    const text = this.firstTurns.get(sessionId);
    if (text === undefined) return;
    this.firstTurns.delete(sessionId);
    this.send(sessionId, { kind: "startTurn", text }).catch((err: Error) => {
      if (err instanceof AgentDisconnected && !(err instanceof CommandTimeout) && this.links.has(sessionId)) {
        this.firstTurns.set(sessionId, text);
        this.log(`bridge link ${sessionId}: devd's first message not sent (${err.message}); retrying on the next connection`);
        return;
      }
      this.log(`bridge link ${sessionId}: devd's first message failed, not resent: ${err.message}`);
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
    if (link.outageLogged) this.log(`bridge link ${sessionId}: reconnected`);
    link.outageLogged = false;
    this.write(link, { t: "hello", afterSeq });
    this.setStatus(sessionId, link, "connected");
    this.sendFirstTurn(sessionId);
  }

  private onClose(sessionId: string, link: Link, why: string) {
    if (link.dropped) return;
    link.socket = null;
    this.failPending(link, why);
    this.down(sessionId, link, why);
  }

  private down(sessionId: string, link: Link, why: string) {
    if (link.dropped) return;
    if (!link.outageLogged) {
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
        this.handle(sessionId, link, parseServerFrame(line));
      } catch (err) {
        // A malformed frame or a store write error: drop this connection (onClose logs why); the reconnect's
        // hello carries the stored seq, so nothing is lost or applied twice.
        const what = err instanceof MalformedFrame ? `malformed frame: ${err.message}` : `cannot apply frame: ${err instanceof Error ? err.message : String(err)}`;
        const socket = link.socket;
        // Detach first: end() may call the close callback synchronously, and it must not run onClose twice.
        this.onClose(sessionId, link, what);
        socket?.end();
        return;
      }
    }
  }

  private handle(sessionId: string, link: Link, f: ServerFrame) {
    switch (f.t) {
      case "event":
        if (!this.d.store(sessionId).apply(f.e)) return;
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
      case "ready":
        this.checkBehind(sessionId, link, f.lastSeq);
        try { this.d.onHandshake?.(sessionId, { version: f.version ?? null, awaitingTarget: f.awaitingTarget === true }); }
        catch (err) { this.log(`bridge link ${sessionId}: onHandshake failed: ${err instanceof Error ? err.message : String(err)}`); }
        return;
    }
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
