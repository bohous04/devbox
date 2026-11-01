import { randomBytes } from "node:crypto";
import type { Target } from "./dbTargets";
import type { Upstream } from "./dbProxy";
import { scramFinal, scramFirstBare } from "./pgAuth";

// The proxy's real connection to Postgres: startup + SCRAM-SHA-256 with the real credentials.
// The client in the container knows nothing about this part — for it the connection is ready as soon as the
// proxy lets the first server message through.
//
// NOTE: the authentication exchange is verified against the RFC 7677 test vectors (pgAuth),
// but the full handshake against a running Postgres is only verified on deploy — locally
// no server is available (only psql from libpq).

const AUTH_OK = 0, AUTH_SASL = 10, AUTH_SASL_CONTINUE = 11, AUTH_SASL_FINAL = 12;

function msg(type: string, body: Buffer): Buffer {
  const b = Buffer.alloc(5 + body.length);
  b.write(type, 0, "latin1");
  b.writeInt32BE(4 + body.length, 1);
  body.copy(b, 5);
  return b;
}

function startupMessage(user: string, database: string): Buffer {
  const body = `user\0${user}\0database\0${database}\0\0`;
  const b = Buffer.alloc(8 + Buffer.byteLength(body));
  b.writeInt32BE(b.length, 0);
  b.writeInt32BE(196608, 4);
  b.write(body, 8, "utf8");
  return b;
}

/** Splits the buffer into complete `type + length + body` messages; returns the rest for completion. */
export function splitMessages(buf: Buffer): { messages: { type: string; body: Buffer }[]; rest: Buffer } {
  const messages: { type: string; body: Buffer }[] = [];
  let off = 0;
  while (buf.length - off >= 5) {
    const len = buf.readInt32BE(off + 1);
    if (buf.length - off < len + 1) break;
    messages.push({ type: buf.subarray(off, off + 1).toString("latin1"), body: buf.subarray(off + 5, off + 1 + len) });
    off += 1 + len;
  }
  return { messages, rest: buf.subarray(off) };
}

export function createPgConnect(opts: { hostname?: string } = {}) {
  /** `onEnd`: the connection target closed (or refused) — the proxy must close the client too, otherwise psql
   *  waits for a reply that never comes. */
  return async function pgConnect(
    target: Target, password: string, onData: (b: Uint8Array) => void, onEnd?: () => void,
  ): Promise<Upstream> {
    const { entry } = target;
    const nonce = randomBytes(18).toString("base64url");
    let buf: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let authed = false;
    let scram: { clientFinal: string; serverSignature: string } | null = null;

    const socket = await Bun.connect({
      hostname: opts.hostname ?? "127.0.0.1",
      port: entry.hostPort,
      socket: {
        open(s) { s.write(startupMessage(entry.roUser, entry.db)); },
        data(s, chunk) {
          // After authentication completes we only forward to the client.
          if (authed) { onData(chunk); return; }
          buf = Buffer.concat([buf, Buffer.from(chunk)]);
          const { messages, rest } = splitMessages(buf);
          buf = rest;
          for (let i = 0; i < messages.length; i++) {
            const m = messages[i]!;
            if (m.type === "E") {
              // The server refused (wrong password, nonexistent role/database): the client MUST see
              // the error — swallowing it would mean psql waiting forever without explanation.
              onData(new Uint8Array(msg("E", m.body)));
              s.end();
              return;
            }
            if (m.type !== "R") continue;   // we do not touch other messages during authentication
            const code = m.body.readInt32BE(0);
            if (code === AUTH_SASL) {
              // The client-first-message goes on the wire = GS2 header "n,," + the bare part. The bare
              // part (without the header) belongs only in the auth-message for signatures (pgAuth.scramFinal).
              // Without the header Postgres replies "malformed SCRAM message … Comma expected,
              // but found character '='" (live 2026-09-05).
              const first = "n,," + scramFirstBare(nonce);
              const mech = Buffer.from("SCRAM-SHA-256\0");
              const len = Buffer.alloc(4); len.writeInt32BE(Buffer.byteLength(first), 0);
              s.write(msg("p", Buffer.concat([mech, len, Buffer.from(first)])));
            } else if (code === AUTH_SASL_CONTINUE) {
              scram = scramFinal(password, nonce, m.body.subarray(4).toString("utf8"));
              s.write(msg("p", Buffer.from(scram.clientFinal)));
            } else if (code === AUTH_SASL_FINAL) {
              // Verify that the server knows the password — otherwise we were talking to a forged server.
              const sv = m.body.subarray(4).toString("utf8");
              if (scram && !sv.includes(scram.serverSignature)) { s.end(); return; }
            } else if (code === AUTH_OK) {
              // From this point on everything belongs to the client — including ParameterStatus,
              // BackendKeyData and ReadyForQuery. Those typically arrive in the SAME chunk
              // as AuthenticationOk and splitMessages has already taken them out of the buffer, so they
              // must be sent from here, not just the rest of the buffer — without ReadyForQuery psql waits
              // forever (live 2026-09-05, first production use).
              authed = true;
              const ok = Buffer.alloc(4); ok.writeInt32BE(AUTH_OK, 0);
              const tail = messages.slice(i + 1).map((x) => msg(x.type, x.body));
              onData(new Uint8Array(Buffer.concat([msg("R", ok), ...tail, buf])));
              buf = Buffer.alloc(0);
              return;
            }
          }
        },
        close() { onEnd?.(); },
        error() { onEnd?.(); },
      },
    });

    return { write: (b) => socket.write(b), end: () => socket.end() };
  };
}
