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
}

export function startServer(o: { socketPath: string; log: EventLog; onCommand: CommandHandler; logError?: (msg: string) => void }): {
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
    const replay = o.log.readFrom(frame.afterSeq);
    for (const e of replay) send(c, { t: "event", e });
    const replayed = replay.length ? replay[replay.length - 1].seq : frame.afterSeq;
    // Events published while the replay was read are in `pending`; skip those the replay already carried.
    for (const e of c.pending) if (e.seq > replayed) send(c, { t: "event", e });
    c.pending = [];
    c.replaying = false;
    send(c, { t: "ready", lastSeq: o.log.lastSeq() });
  };

  const listener = Bun.listen<Client>({
    unix: o.socketPath,
    socket: {
      open(socket) {
        const c: Client = { socket, buffer: "", outbound: [], outboundHead: 0, decoder: new TextDecoder(), replaying: false, hello: false, pending: [], commands: Promise.resolve() };
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
      },
      close(socket) {
        clients.delete(socket.data);
      },
      error(socket, err) {
        logError(`agent-bridge: socket error: ${err.message}`);
        clients.delete(socket.data);
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
      for (const c of clients) c.socket.end();
      clients.clear();
      rmSync(o.socketPath, { force: true });
    },
  };
}
