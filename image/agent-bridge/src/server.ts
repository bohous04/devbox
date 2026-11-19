import { chmodSync, rmSync } from "node:fs";
import type { Socket } from "bun";
import type { BridgeEvent, LoggedEvent } from "./events";
import type { EventLog } from "./eventLog";
import { encodeFrame, parseClientFrame, type BridgeCommand, type ServerFrame } from "./protocol";

export interface CommandHandler {
  /** A returned value is sent back to the client as the `res` frame's `result`. */
  (cmd: BridgeCommand): Promise<unknown>;
}

interface Client {
  socket: Socket<Client>;
  buffer: string;
  /** Encoded frames the socket did not accept yet; flushed on drain. */
  outbound: Buffer[];
  outboundHead: number;
  decoder: TextDecoder;
  /** True from hello until its replay is written; live events wait in `pending`. */
  replaying: boolean;
  hello: boolean;
  pending: LoggedEvent[];
  commands: Promise<void>;
  /** Resolves a replay waiting for the socket to drain (or to close). */
  wake: (() => void) | null;
}

export interface Handshake {
  version: string;
  awaitingTarget: boolean;
}

export function startServer(o: {
  socketPath: string;
  log: EventLog;
  onCommand: CommandHandler;
  handshake: () => Handshake;
  /** A hello's `afterSeq`: devd has stored every event up to it. Called before the replay. */
  onHello?: (afterSeq: number) => void;
  logError?: (msg: string) => void;
}): {
  publish(e: BridgeEvent): LoggedEvent;
  close(): Promise<void>;
} {
  rmSync(o.socketPath, { force: true });
  const clients = new Set<Client>();
  const logError = o.logError ?? ((msg: string) => console.error(msg));

  const flush = (c: Client) => {
    while (c.outboundHead < c.outbound.length) {
      const frame = c.outbound[c.outboundHead];
      const n = Math.max(c.socket.write(frame), 0);
      if (n < frame.length) {
        c.outbound[c.outboundHead] = frame.subarray(n);
        return;
      }
      c.outboundHead++;
    }
    c.outbound = [];
    c.outboundHead = 0;
  };
  const send = (c: Client, f: ServerFrame) => {
    c.outbound.push(Buffer.from(encodeFrame(f)));
    flush(c);
  };

  const drop = (c: Client) => {
    clients.delete(c);
    c.socket.end();
  };
  const wake = (c: Client) => {
    const w = c.wake;
    c.wake = null;
    w?.();
  };

  /** Streams the log after `afterSeq` from disk, waiting for the socket to drain whenever it is full, so a long
   *  replay never sits in memory whole. Live events published meanwhile wait in `pending`. */
  const replay = async (c: Client, afterSeq: number) => {
    let replayed = afterSeq;
    for (const e of o.log.stream(afterSeq)) {
      if (!clients.has(c)) return;
      send(c, { t: "event", e });
      replayed = e.seq;
      if (c.outboundHead < c.outbound.length) await new Promise<void>((r) => (c.wake = r));
    }
    if (!clients.has(c)) return;
    // Skip events the replay already carried.
    for (const e of c.pending) if (e.seq > replayed) send(c, { t: "event", e });
    c.pending = [];
    c.replaying = false;
    send(c, { t: "ready", lastSeq: o.log.lastSeq(), ...o.handshake() });
  };

  const runCommand = (c: Client, id: string, cmd: BridgeCommand) => {
    c.commands = c.commands.then(async () => {
      try {
        const result = await o.onCommand(cmd);
        send(c, { t: "res", id, ok: true, ...(result === undefined ? {} : { result }) });
      } catch (err) {
        send(c, { t: "res", id, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    });
  };

  const handleLine = (c: Client, line: string) => {
    const frame = parseClientFrame(line);
    if (frame.t === "cmd") return runCommand(c, frame.id, frame.cmd);
    if (c.hello) throw new Error("duplicate hello");
    c.hello = true;
    c.replaying = true;
    o.onHello?.(frame.afterSeq);
    const done = replay(c, frame.afterSeq).catch((err) => {
      logError(`agent-bridge: replay failed, closing client: ${err instanceof Error ? err.message : String(err)}`);
      drop(c);
    });
    // Commands sent with the hello are answered after its ready, as before the replay was streamed.
    c.commands = c.commands.then(() => done);
  };

  const listener = Bun.listen<Client>({
    unix: o.socketPath,
    socket: {
      open(socket) {
        const c: Client = { socket, buffer: "", outbound: [], outboundHead: 0, decoder: new TextDecoder(), replaying: false, hello: false, pending: [], commands: Promise.resolve(), wake: null };
        socket.data = c;
        clients.add(c);
      },
      data(socket, chunk) {
        const c = socket.data;
        // stream:true keeps a multibyte character split across reads intact.
        c.buffer += c.decoder.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = c.buffer.indexOf("\n")) >= 0) {
          const line = c.buffer.slice(0, nl);
          c.buffer = c.buffer.slice(nl + 1);
          if (!line) continue;
          try {
            handleLine(c, line);
          } catch (err) {
            logError(`agent-bridge: closing client: ${err instanceof Error ? err.message : String(err)}`);
            drop(c);
            return;
          }
        }
      },
      drain(socket) {
        flush(socket.data);
        if (socket.data.outboundHead >= socket.data.outbound.length) wake(socket.data);
      },
      close(socket) {
        clients.delete(socket.data);
        wake(socket.data);
      },
      error(socket, err) {
        logError(`agent-bridge: socket error: ${err.message}`);
        clients.delete(socket.data);
        wake(socket.data);
      },
    },
  });
  chmodSync(o.socketPath, 0o666);

  return {
    publish(e) {
      // Append before any write: a client connecting now sees the event in its replay or live, never both or neither.
      const logged = o.log.append(e);
      for (const c of clients) {
        if (!c.hello) continue;
        if (c.replaying) c.pending.push(logged);
        else send(c, { t: "event", e: logged });
      }
      return logged;
    },
    async close() {
      listener.stop(true);
      const all = [...clients];
      clients.clear();
      for (const c of all) {
        c.socket.end();
        wake(c);
      }
      rmSync(o.socketPath, { force: true });
    },
  };
}
