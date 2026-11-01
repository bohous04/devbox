import { expect, test } from "bun:test";
import { parseStartup } from "../src/pgWire";

function startup(pairs: Record<string, string>): Buffer {
  const body = Object.entries(pairs).flatMap(([k, v]) => [k, v]).join("\0") + "\0\0";
  const len = 8 + Buffer.byteLength(body);
  const b = Buffer.alloc(len);
  b.writeInt32BE(len, 0);
  b.writeInt32BE(196608, 4);   // protokol 3.0
  b.write(body, 8, "utf8");
  return b;
}

test("reads the user and the database", () => {
  expect(parseStartup(startup({ user: "app", database: "shop" }))).toEqual({ ok: true, user: "app", database: "shop" });
});

test("without database the user name is used, as psql does", () => {
  expect(parseStartup(startup({ user: "app" }))).toEqual({ ok: true, user: "app", database: "app" });
});

test("SSLRequest is recognised and not confused with startup", () => {
  const b = Buffer.alloc(8);
  b.writeInt32BE(8, 0); b.writeInt32BE(80877103, 4);
  expect(parseStartup(b)).toEqual({ ok: false, reason: "ssl-request" });
});

test("a truncated packet reports incomplete, not bad", () => {
  expect(parseStartup(startup({ user: "app" }).subarray(0, 6))).toEqual({ ok: false, reason: "incomplete" });
});

test("a packet without a user is bad", () => {
  expect(parseStartup(startup({ database: "shop" }))).toEqual({ ok: false, reason: "bad" });
});

test("a buffer longer than one packet is fine — it is read by length", () => {
  const s = startup({ user: "app", database: "shop" });
  expect(parseStartup(Buffer.concat([s, Buffer.from("extra")]))).toEqual({ ok: true, user: "app", database: "shop" });
});
