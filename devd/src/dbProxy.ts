import type { DbEntry } from "./prodDb";
import type { DbTargets, Target } from "./dbTargets";
import { parseStartup } from "./pgWire";
import type { Vault } from "./vault";

// Proxy for Postgres. The client in the container authenticates with a DUMMY; the proxy maps it to a target,
// takes the real password from the vault and connects itself. The password never gets into the container.
//
// The RULE this whole phase rests on: when something does not fit — unknown dummy, locked vault,
// unavailable password — the connection is CLOSED. Silently letting it through without authentication
// would look like a working proxy while defeating the whole point.

/** Authenticated connection to the target. The caller does the byte splicing. */
export interface Upstream { write(b: Uint8Array): void; end(): void }

export interface DbProxyDeps {
  port: number;
  hostname: string;
  targets: DbTargets;
  vault: Vault;
  /** Reads the real password from 1P (host-side). May be async — since PR #75+ reading from 1P
   *  is asynchronous. If it throws, the connection is closed. */
  readSecret: (opItem: string) => string | Promise<string>;
  /** `onData` is the only path by which the target's response gets back to the client —
   *  without it the proxy could only send queries and never return anything. `onEnd` says that
   *  the target closed the connection: the proxy then closes the client too, so it does not hang on a dead connection. */
  connect: (target: Target, password: string, onData: (b: Uint8Array) => void, onEnd?: () => void) => Promise<Upstream>;
  audit?: (e: { session: string; db: string }) => void;
}

export interface RunningDbProxy { port: number; stop(): void }

const SSL_NO = Buffer.from("N");   // response to SSLRequest: no TLS, the network never leaves the bridge

// `data` is async (1P read + tunnel + SCRAM), so the socket goes through phases: further chunks
// arriving while connecting must neither start a second upstream nor be lost, and a client that
// disconnects mid-handshake must not leave the freshly opened upstream dangling.
type Phase = "startup" | "connecting" | "relay" | "closed";
interface ConnState { phase: Phase; buf: Buffer; pending: Uint8Array[]; upstream: Upstream | null }

export async function startDbProxy(d: DbProxyDeps): Promise<RunningDbProxy> {
  const server = Bun.listen<ConnState>({
    hostname: d.hostname,
    port: d.port,
    socket: {
      open(socket) { socket.data = { phase: "startup", buf: Buffer.alloc(0), pending: [], upstream: null }; },

      async data(socket, chunk) {
        const st = socket.data;
        // Once established we only forward — the proxy does not see into query contents.
        if (st.phase === "relay") { st.upstream!.write(chunk); return; }
        if (st.phase === "connecting") { st.pending.push(Buffer.from(chunk)); return; }
        if (st.phase === "closed") return;

        st.buf = Buffer.concat([st.buf, Buffer.from(chunk)]);
        const start = parseStartup(st.buf);

        if (!start.ok) {
          if (start.reason === "incomplete") return;             // wait for the rest
          if (start.reason === "ssl-request") {                  // refuse TLS and wait for startup
            socket.write(SSL_NO);
            st.buf = Buffer.alloc(0);
            return;
          }
          socket.end(); return;                                  // bad
        }

        const target = d.targets.resolve(start.user);
        if (!target || target.entry.engine !== "postgres") { socket.end(); return; }                   // unknown dummy
        if (d.vault.isLocked()) { socket.end(); return; }        // locked vault

        st.phase = "connecting";
        // Bytes pipelined after the startup message belong to the relay, not to the handshake.
        const rest = st.buf.subarray(st.buf.readInt32BE(0));
        if (rest.length) st.pending.push(rest);
        st.buf = Buffer.alloc(0);

        let password: string;
        try { password = await d.readSecret(target.entry.opItem); }
        catch { socket.end(); return; }                          // password unavailable
        if (st.phase !== "connecting") return;                   // client left while reading the secret

        d.audit?.({ session: target.session, db: target.entry.name });
        let upstream: Upstream;
        try { upstream = await d.connect(target, password, (b) => socket.write(b), () => socket.end()); }
        catch { socket.end(); return; }                          // target unavailable
        if (st.phase !== "connecting") { upstream.end(); return; } // client left during the handshake
        st.upstream = upstream;
        st.phase = "relay";
        for (const b of st.pending.splice(0)) upstream.write(b);
      },

      close(socket) { closeConn(socket.data); },
      error(socket) { closeConn(socket.data); },
    },
  });

  return { port: server.port, stop: () => server.stop(true) };
}

function closeConn(st: ConnState | undefined) {
  if (!st) return;
  st.phase = "closed";
  st.pending = [];
  st.upstream?.end();
  st.upstream = null;
}

export type { DbEntry };
