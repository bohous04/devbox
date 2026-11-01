import { createServer, connect, type Socket } from "node:net";
import { randomBytes } from "node:crypto";
import type { DbTargets, Target } from "./dbTargets";
import { mysqlResponse } from "./mysqlAuth";

// Protocol 4.1, native auth, transactions, multiple results and prepared statements.
// No TLS/compression/local infile/session tracking: do not negotiate framing which
// the splice cannot preserve. TLS is provided by the host's SSH upstream tunnel.
const FLAGS = 1 | 2 | 4 | 8 | 512 | 8192 | 32768 | 65536 | 131072 | 262144 | 524288;
const REQUIRED = 512 | 32768 | 524288;
export function mysqlPacket(body: Buffer, sequence: number): Buffer {
  const header = Buffer.alloc(4); header.writeUIntLE(body.length, 0, 3); header[3] = sequence;
  return Buffer.concat([header, body]);
}
function zero(buf: Buffer, start: number): [string, number] {
  const end = buf.indexOf(0, start); if (end < start) throw Error("invalid handshake");
  return [buf.toString("utf8", start, end), end + 1];
}
function greeting(salt: Buffer): Buffer {
  // Construct variable strings separately to avoid relying on their byte lengths.
  const version = Buffer.from("5.5.5-10.11.0-devbox\0");
  const fixed = Buffer.alloc(4 + 8 + 1 + 2 + 1 + 2 + 2 + 1 + 10);
  fixed.writeUInt32LE(1, 0); salt.copy(fixed, 4, 0, 8);
  fixed.writeUInt16LE(FLAGS & 65535, 13); fixed[15] = 45;
  fixed.writeUInt16LE(2, 16); fixed.writeUInt16LE(FLAGS >>> 16, 18); fixed[20] = 21;
  return mysqlPacket(Buffer.concat([Buffer.from([10]), version, fixed, salt.subarray(8), Buffer.from("\0mysql_native_password\0")]), 0);
}
function clientHello(body: Buffer) {
  if (body.length < 34) throw Error("short handshake");
  const flags = body.readUInt32LE(0) & FLAGS;
  if ((flags & REQUIRED) !== REQUIRED) throw Error("unsupported capabilities");
  let [user, i] = zero(body, 32);
  const length = body[i++]!;
  if (i + length > body.length) throw Error("short auth");
  const response = body.subarray(i, i + length); i += length;
  let database = ""; if (flags & 8) [database, i] = zero(body, i);
  const [plugin] = zero(body, i); if (plugin !== "mysql_native_password") throw Error("unsupported auth");
  return { user, flags, response, database, charset: body[8]! };
}
function upstreamHello(body: Buffer) {
  if (body[0] !== 10) throw Error("unsupported protocol");
  const [, versionEnd] = zero(body, 1); const start = versionEnd + 4;
  if (body.length < start + 27) throw Error("short greeting");
  const low = body.readUInt16LE(start + 9), high = body.readUInt16LE(start + 14);
  const salt = Buffer.concat([body.subarray(start, start + 8), body.subarray(start + 27, start + 39)]);
  if (salt.length !== 20) throw Error("short salt");
  const [plugin] = zero(body, start + 40);
  if (plugin !== "mysql_native_password") throw Error("unsupported upstream auth");
  return { flags: (low | (high << 16)) >>> 0, salt };
}
export interface MysqlProxyDeps {
  port: number; hostname: string; targets: DbTargets;
  vault: { isLocked(): boolean };
  readSecret(item: string): string | Promise<string>;
  ensureTunnel(target: Target): Promise<void>;
  audit?(event: { session: string; db: string }): void;
}
/** Authenticate each side independently, then splice the negotiated protocol.
 * Queries, binary prepared statements and multi-results remain byte-for-byte. */
export async function startMysqlProxy(d: MysqlProxyDeps) {
  const sockets = new Set<Socket>();
  const server = createServer(client => {
    sockets.add(client);
    const salt = randomBytes(20); let upstream: Socket | undefined;
    let buffer = Buffer.alloc(0), phase: "client" | "connecting" | "relay" | "closed" = "client";
    const shutdown = () => { phase = "closed"; clearTimeout(timeout); client.destroy(); upstream?.destroy(); };
    const fail = () => {
      if (phase === "closed") return;
      const error = Buffer.concat([Buffer.from([255, 21, 4]), Buffer.from("#28000Database proxy authentication or connection failed")]);
      client.end(mysqlPacket(error, 2), () => client.destroy()); upstream?.destroy(); phase = "closed"; clearTimeout(timeout);
    };
    const timeout = setTimeout(fail, 30_000); timeout.unref();
    client.on("error", shutdown); client.on("close", () => { sockets.delete(client); shutdown(); });
    client.write(greeting(salt));
    const onClient = (chunk: Buffer) => {
      if (phase !== "client") { fail(); return; }
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 65536) { fail(); return; }
      if (buffer.length < 4) return;
      const length = buffer.readUIntLE(0, 3); if (length > 65532) { fail(); return; }
      if (buffer.length < length + 4) return;
      if (buffer.length !== length + 4 || buffer[3] !== 1) { fail(); return; }
      phase = "connecting"; client.pause();
      void (async () => {
        const hello = clientHello(buffer.subarray(4));
        const target = d.targets.authenticateMysql(hello.user, salt, hello.response);
        if (!target || d.vault.isLocked() || (hello.database && hello.database !== target.entry.db)) throw Error("denied");
        const password = await d.readSecret(target.entry.opItem);
        await d.ensureTunnel(target);
        if (client.destroyed || d.vault.isLocked() || !d.targets.resolve(hello.user)) throw Error("closed");
        upstream = connect({ host: "127.0.0.1", port: target.entry.hostPort });
        sockets.add(upstream);
        upstream.on("error", fail); upstream.on("close", () => { sockets.delete(upstream!); shutdown(); });
        let pending = Buffer.alloc(0), sentAuth = false;
        const onUpstream = (chunk: Buffer) => {
          try {
            pending = Buffer.concat([pending, chunk]);
            if (pending.length > 65536) throw Error("oversized handshake");
            if (pending.length < 4) return;
            const size = pending.readUIntLE(0, 3); if (size > 65532) throw Error("oversized packet");
            if (pending.length < size + 4) return;
            const sequence = pending[3], body = pending.subarray(4, size + 4), tail = pending.subarray(size + 4);
            pending = Buffer.alloc(0);
            if (!sentAuth) {
              if (sequence !== 0 || tail.length) throw Error("invalid greeting sequence");
              const peer = upstreamHello(body);
              if ((hello.flags & (peer.flags | 1)) !== hello.flags) throw Error("capability mismatch");
              const header = Buffer.alloc(32); header.writeUInt32LE(hello.flags | 8, 0); header.writeUInt32LE(16777216, 4); header[8] = hello.charset;
              const response = mysqlResponse(password, peer.salt);
              upstream!.write(mysqlPacket(Buffer.concat([header, Buffer.from(target.entry.roUser + "\0"), Buffer.from([response.length]), response,
                Buffer.from(target.entry.db + "\0mysql_native_password\0")]), 1));
              sentAuth = true;
            } else {
              if (sequence !== 2 || body[0] !== 0 || d.vault.isLocked() || !d.targets.resolve(hello.user)) throw Error("upstream rejected");
              clearTimeout(timeout); phase = "relay";
              client.removeListener("data", onClient); upstream!.removeListener("data", onUpstream);
              client.write(mysqlPacket(body, 2)); if (tail.length) client.write(tail);
              upstream!.pipe(client); client.pipe(upstream!); client.resume();
              d.audit?.({ session: target.session, db: target.entry.name });
            }
          } catch { fail(); }
        };
        upstream.on("data", onUpstream);
      })().catch(fail);
    };
    client.on("data", onClient);
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(d.port, d.hostname, resolve); });
  return { port: (server.address() as { port: number }).port, stop: () => { for (const socket of sockets) socket.destroy(); server.close(); } };
}
