import { expect, test } from "bun:test";
import { createPgConnect, splitMessages } from "../src/pgConnect";

function msg(type: string, body: string): Buffer {
  const b = Buffer.alloc(5 + body.length);
  b.write(type, 0, "latin1"); b.writeInt32BE(4 + body.length, 1); b.write(body, 5, "latin1");
  return b;
}

test("splits two complete messages", () => {
  const { messages, rest } = splitMessages(Buffer.concat([msg("R", "abcd"), msg("S", "xy")]));
  expect(messages.map((m) => m.type)).toEqual(["R", "S"]);
  expect(rest.length).toBe(0);
});

test("keeps an incomplete message for next time, does not drop it", () => {
  const full = msg("R", "abcd");
  const { messages, rest } = splitMessages(full.subarray(0, 6));
  expect(messages.length).toBe(0);
  expect(rest.length).toBe(6);
});

test("does not treat a header shorter than 5 bytes as a message", () => {
  expect(splitMessages(Buffer.from([82, 0, 0])).messages.length).toBe(0);
});

// --- handshake against a fake server --------------------------------------------------

const target = (port: number) => ({
  session: "s1",
  entry: { name: "db", server: "x", engine: "postgres" as const, hostPort: port, db: "db", roUser: "ro", opItem: "o" },
});

function authOk(): Buffer { const b = Buffer.alloc(4); b.writeInt32BE(0, 0); return msg("R", b.toString("latin1")); }

/** Fake Postgres: after the client's startup it sends `reply` and (optionally) closes. */
function fakeServer(reply: Buffer, closeAfter = false) {
  return Bun.listen<undefined>({
    hostname: "127.0.0.1", port: 0,
    socket: {
      open() {},
      data(s) { s.write(reply); if (closeAfter) s.end(); },
    },
  });
}

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const t0 = Date.now();
  while (!cond() && Date.now() - t0 < ms) await Bun.sleep(10);
}

// Live on 2026-09-05: the server sends AuthenticationOk + ParameterStatus + BackendKeyData +
// ReadyForQuery in ONE chunk; the proxy forwarded only AuthenticationOk and swallowed
// the rest → psql in the container waited for ReadyForQuery forever.
test("messages after AuthenticationOk in the same chunk reach the client (ReadyForQuery)", async () => {
  const srv = fakeServer(Buffer.concat([authOk(), msg("S", "server_version\0" + "16\0"), msg("Z", "I")]));
  const got: Buffer[] = [];
  try {
    await createPgConnect()(target(srv.port), "pw", (b) => got.push(Buffer.from(b)));
    await until(() => Buffer.concat(got).includes(msg("Z", "I")));
    const all = Buffer.concat(got);
    expect(all.indexOf(authOk())).toBe(0);                    // AuthenticationOk first
    expect(all.includes(msg("S", "server_version\0" + "16\0"))).toBe(true);
    expect(all.includes(msg("Z", "I"))).toBe(true);           // …and ReadyForQuery after it
  } finally { srv.stop(true); }
});

// On the wire client-first-message must start with the GS2 header "n,," — Postgres rejects the bare
// part without it ("Comma expected, but found character '='", live on 2026-09-05).
test("SASLInitialResponse carries the GS2 header n,, before client-first-bare", async () => {
  let initial = "";
  const srv = Bun.listen<{ step: number }>({
    hostname: "127.0.0.1", port: 0,
    socket: {
      open(s) { s.data = { step: 0 }; },
      data(s, chunk) {
        if (s.data.step === 0) {                 // startup → request SCRAM
          const code = Buffer.alloc(4); code.writeInt32BE(10, 0);
          s.write(msg("R", code.toString("latin1") + "SCRAM-SHA-256\0" + "\0"));
          s.data.step = 1; return;
        }
        const b = Buffer.from(chunk);            // 'p' + len + mech\0 + int32 + initial
        const mechEnd = b.indexOf(0, 5);
        const n = b.readInt32BE(mechEnd + 1);
        initial = b.subarray(mechEnd + 5, mechEnd + 5 + n).toString("utf8");
        s.end();
      },
    },
  });
  try {
    await createPgConnect()(target(srv.port), "pw", () => {});
    await until(() => initial !== "");
    expect(initial.startsWith("n,,n=,r=")).toBe(true);
  } finally { srv.stop(true); }
});

test("a server rejection (ErrorResponse) is passed to the client and the connection closes", async () => {
  const srv = fakeServer(msg("E", "SFATAL\0" + "Mpassword authentication failed\0" + "\0"), true);
  const got: Buffer[] = [];
  let ended = false;
  try {
    await createPgConnect()(target(srv.port), "pw", (b) => got.push(Buffer.from(b)), () => { ended = true; });
    await until(() => ended);
    expect(Buffer.concat(got).toString("latin1")).toContain("password authentication failed");
    expect(ended).toBe(true);
  } finally { srv.stop(true); }
});
