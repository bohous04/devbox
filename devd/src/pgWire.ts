// Minimal reading of the Postgres wire protocol opening — only as much as the proxy needs to
// know WHERE the connection belongs. After that it just forwards bytes and cannot see the content.
//
// The opening has two forms and mixing them up means the client hangs: either SSLRequest
// (8 bytes with a magic number), or StartupMessage with key/value pairs.
const SSL_REQUEST = 80877103;
const HEADER = 8;   // length (4) + protocol version or magic number (4)

export type Startup =
  | { ok: true; user: string; database: string }
  | { ok: false; reason: "ssl-request" | "incomplete" | "bad" };

export function parseStartup(buf: Buffer): Startup {
  if (buf.length < HEADER) return { ok: false, reason: "incomplete" };
  const len = buf.readInt32BE(0);
  if (buf.readInt32BE(4) === SSL_REQUEST) return { ok: false, reason: "ssl-request" };
  if (len < HEADER || buf.length < len) return { ok: false, reason: "incomplete" };

  const parts = buf.subarray(HEADER, len).toString("utf8").split("\0");
  const kv: Record<string, string> = {};
  for (let i = 0; i + 1 < parts.length; i += 2) if (parts[i]) kv[parts[i]!] = parts[i + 1]!;
  if (!kv.user) return { ok: false, reason: "bad" };
  // psql without -d sends only `user` and the database has the same name — we behave the same.
  return { ok: true, user: kv.user, database: kv.database ?? kv.user };
}
