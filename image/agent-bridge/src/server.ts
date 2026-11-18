import { chmodSync, rmSync } from "node:fs";
import type { Socket } from "bun";
import type { BridgeEvent, LoggedEvent } from "./events";
import type { EventLog } from "./eventLog";
import { encodeFrame, parseClientFrame, type BridgeCommand, type ServerFrame } from "./protocol";

export interface CommandHandler {
  (cmd: BridgeCommand): Promise<void>;
}

interface Client {
  socket: Socket<Client>;
  buffer: string;
  /** Bytes the socket did not accept yet; flushed on drain. */
  outbound: Buffer;
  /** True from hello until its replay is written; live events wait in `pending`. */
  replaying: boolean;
  hello: boolean;
  pending: LoggedEvent[];
  commands: Promise<void>;
}

export function startServer(o: { socketPath: string; log: EventLog; onCommand: CommandHandler }): {
  publish(e: BridgeEvent): LoggedEvent;
  close(): Promise<void>;
} {
  rmSync(o.socketPath, { force: true });
  const clients = new Set<Client>();

  const flush = (c: Client) => {
    if (!c.outbound.length) return;
    const n = c.socket.write(c.outbound);
    c.outbound = c.outbound.subarray(Math.max(n, 0));
  };
  const send = (c: Client, f: ServerFrame) => {
    c.outbound = Buffer.concat([c.outbound, Buffer.from(encodeFrame(f))]);
    flush(c);
  };

  const drop = (c: Client) => {
    clients.delete(c);
    c.socket.end();
  };

  const runCommand = (c: Client, id: string, cmd: BridgeCommand) => {
    c.commands = c.commands.then(async () => {
      try {
        await o.onCommand(cmd);
        send(c, { t: "res", id, ok: true });
      } catch (err) {
        send(c, { t: "res", id, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    });
  };

  const handleLine = (c: Client, line: string) => {
    const frame = parseClientFrame(line);
    if (frame.t === "cmd") return runCommand(c, frame.id, frame.cmd);
    if (c.hello) return;
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
        const c: Client = { socket, buffer: "", outbound: Buffer.alloc(0), replaying: false, hello: false, pending: [], commands: Promise.resolve() };
        socket.data = c;
        clients.add(c);
      },
      data(socket, chunk) {
        const c = socket.data;
        c.buffer += chunk.toString("utf8");
        let nl: number;
        while ((nl = c.buffer.indexOf("\n")) >= 0) {
          const line = c.buffer.slice(0, nl);
          c.buffer = c.buffer.slice(nl + 1);
          if (!line) continue;
          try {
            handleLine(c, line);
          } catch (err) {
            console.error(`agent-bridge: closing client: ${err instanceof Error ? err.message : String(err)}`);
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
        console.error(`agent-bridge: socket error: ${err.message}`);
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
