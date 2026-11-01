import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { existsSync, readFileSync as rf, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SHIM = join(import.meta.dir, "..", "..", "image", "preview");

// /proc/net/tcp fixture: a LISTEN (st=0A) socket on the given hex IP:port
function procnet(rows: { ip: string; port: number }[]): string {
  const head = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n";
  const lines = rows.map((r, i) => {
    const hexPort = r.port.toString(16).toUpperCase().padStart(4, "0");
    return `   ${i}: ${r.ip}:${hexPort} 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 0 1 0000 0 0 0 0 0`;
  });
  return head + lines.join("\n") + "\n";
}
const ANY = "00000000";       // 0.0.0.0
const LOOP = "0100007F";      // 127.0.0.1

function writeProcnet(rows: { ip: string; port: number }[]): string {
  const dir = mkdtempSync(join(tmpdir(), "preview-"));
  const f = join(dir, "procnet");
  writeFileSync(f, procnet(rows));
  return f;
}

async function run(args: string[], env: Record<string, string>) {
  const p = Bun.spawn(["bun", SHIM, ...args], { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  const code = await p.exited;
  return { code, stdout: await new Response(p.stdout).text(), stderr: await new Response(p.stderr).text() };
}

// devd stub that records the /api/preview body and returns {url}
function stubDevd() {
  const bodies: { sessionId?: string; containerPort?: number; path?: string }[] = [];
  const srv = Bun.serve({ port: 0, fetch: async (req) => {
    const b = (await req.json()) as { sessionId?: string; containerPort?: number; path?: string };
    bodies.push(b);
    return Response.json({ url: `http://tailnet:${b.containerPort}${b.path ?? ""}` });
  }});
  return { srv, bodies, url: `http://127.0.0.1:${srv.port}` };
}

test("preview outside a session is a no-op", async () => {
  const r = await run([], { DEVD_SESSION_ID: "", DEVD_URL: "http://x" });
  expect(r.code).toBe(1);
  expect(r.stderr + r.stdout).toMatch(/session/i);
});

test("preview direct: 0.0.0.0 in range → sends that port, no relay", async () => {
  const { srv, bodies, url } = stubDevd();
  const procnet = writeProcnet([{ ip: ANY, port: 3000 }]);
  try {
    const r = await run(["3000"], { DEVD_SESSION_ID: "sess1", DEVD_URL: url, PREVIEW_PROCNET: procnet });
    expect(r.code).toBe(0);
    expect(bodies[0]).toEqual({ sessionId: "sess1", containerPort: 3000, path: "" });
    expect(r.stdout).toMatch(/http:\/\/tailnet:3000/);
  } finally { srv.stop(true); }
});

test("preview autodetection: exactly one server → take it", async () => {
  const { srv, bodies, url } = stubDevd();
  const procnet = writeProcnet([{ ip: ANY, port: 3002 }]);
  try {
    const r = await run([], { DEVD_SESSION_ID: "sess1", DEVD_URL: url, PREVIEW_PROCNET: procnet });
    expect(r.code).toBe(0);
    expect(bodies[0]?.containerPort).toBe(3002);
  } finally { srv.stop(true); }
});

test("preview autodetection: no server → error, nothing is sent", async () => {
  const { srv, bodies, url } = stubDevd();
  const procnet = writeProcnet([]);
  try {
    const r = await run([], { DEVD_SESSION_ID: "sess1", DEVD_URL: url, PREVIEW_PROCNET: procnet });
    expect(r.code).toBe(1);
    expect(bodies).toEqual([]);
  } finally { srv.stop(true); }
});

test("preview autodetection: several servers → print the list, error", async () => {
  const { srv, bodies, url } = stubDevd();
  const procnet = writeProcnet([{ ip: ANY, port: 3000 }, { ip: ANY, port: 3001 }]);
  try {
    const r = await run([], { DEVD_SESSION_ID: "sess1", DEVD_URL: url, PREVIEW_PROCNET: procnet });
    expect(r.code).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/3000/);
    expect(r.stdout + r.stderr).toMatch(/3001/);
    expect(bodies).toEqual([]);
  } finally { srv.stop(true); }
});

test("preview passes the path", async () => {
  const { srv, bodies, url } = stubDevd();
  const procnet = writeProcnet([{ ip: ANY, port: 3000 }]);
  try {
    await run(["3000", "/admin"], { DEVD_SESSION_ID: "sess1", DEVD_URL: url, PREVIEW_PROCNET: procnet });
    expect(bodies[0]).toEqual({ sessionId: "sess1", containerPort: 3000, path: "/admin" });
  } finally { srv.stop(true); }
});

test("preview explicit port without a server → error, no blind relay", async () => {
  const { srv, bodies, url } = stubDevd();
  const procnet = writeProcnet([]); // nobody is listening
  try {
    const r = await run(["3000"], { DEVD_SESSION_ID: "sess1", DEVD_URL: url, PREVIEW_PROCNET: procnet, PREVIEW_RETRIES: "0" });
    expect(r.code).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/is listening/);
    expect(bodies).toEqual([]);
  } finally { srv.stop(true); }
});

// stub relay bin: writes argv to a file and exits right away (no long-running process)
// note: shebang via `env` (not the fixed path /usr/local/bin/bun) + chmod +x, so the stub
// can run outside the devbox image too (where bun lives exactly at /usr/local/bin/bun).
function stubRelayBin(recordFile: string): string {
  const dir = mkdtempSync(join(tmpdir(), "relaybin-"));
  const f = join(dir, "relay");
  writeFileSync(f, `#!/usr/bin/env bun\nimport { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(recordFile)}, process.argv.slice(2).join(" ") + "\\n");\n`);
  chmodSync(f, 0o755);
  return f;
}
function runDir(): string { return mkdtempSync(join(tmpdir(), "prev-run-")); }

// wait until the relay stub finishes writing its record — a cold start of the `bun` process takes longer than
// a few tens of ms, so a fixed short sleep would make the test flaky.
// Waits for NON-EMPTY content, not just for the file to exist. Both callers read the content
// right after returning, but between creating the file and writing the data there is a window in which
// the file exists and is empty — under the load of the full suite it widens enough that the test
// gets "" instead of the expected ports. That is exactly how it failed once; on its own it
// never reproduces, because the window is then tiny.
async function waitForFile(path: string, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!existsSync(path) || rf(path, "utf8").trim() === "") {
    if (Date.now() - start > timeoutMs) throw new Error(`waitForFile: ${path} did not appear (or stayed empty) within ${timeoutMs}ms`);
    await Bun.sleep(25);
  }
}

test("preview relay: loopback bind → relay to a free published port", async () => {
  const { srv, bodies, url } = stubDevd();
  const procnet = writeProcnet([{ ip: LOOP, port: 3000 }]); // server only on 127.0.0.1:3000
  const rec = join(runDir(), "calls.txt");
  const relayBin = stubRelayBin(rec);
  try {
    const r = await run(["3000"], {
      DEVD_SESSION_ID: "sess1", DEVD_URL: url, PREVIEW_PROCNET: procnet,
      PREVIEW_RUN_DIR: runDir(), PREVIEW_RELAY_BIN: relayBin,
    });
    expect(r.code).toBe(0);
    // 3000 taken by the server → the first free one is 3001; relay 3001 → 3000
    expect(bodies[0]?.containerPort).toBe(3001);
    await waitForFile(rec);
    expect(rf(rec, "utf8").trim()).toBe("3001 3000");
  } finally { srv.stop(true); }
});

test("preview relay: port out of range (5173) → relay to 3000", async () => {
  const { srv, bodies, url } = stubDevd();
  const procnet = writeProcnet([{ ip: LOOP, port: 5173 }]);
  const rec = join(runDir(), "calls.txt");
  const relayBin = stubRelayBin(rec);
  try {
    const r = await run(["5173"], {
      DEVD_SESSION_ID: "sess1", DEVD_URL: url, PREVIEW_PROCNET: procnet,
      PREVIEW_RUN_DIR: runDir(), PREVIEW_RELAY_BIN: relayBin,
    });
    expect(r.code).toBe(0);
    expect(bodies[0]?.containerPort).toBe(3000);
    await waitForFile(rec);
    expect(rf(rec, "utf8").trim()).toBe("3000 5173");
  } finally { srv.stop(true); }
});

test("preview relay idempotence: a live pidfile for the target → reuse, the relay is not started", async () => {
  const { srv, bodies, url } = stubDevd();
  const procnet = writeProcnet([{ ip: LOOP, port: 5173 }]);
  const rec = join(runDir(), "calls.txt");
  const relayBin = stubRelayBin(rec);
  const rd = runDir();
  // pre-create a live pidfile: pid = this test process (surely running), listen = 3007
  writeFileSync(join(rd, "preview-relay-5173.pid"), `${process.pid}\n3007\n`);
  try {
    const r = await run(["5173"], {
      DEVD_SESSION_ID: "sess1", DEVD_URL: url, PREVIEW_PROCNET: procnet,
      PREVIEW_RUN_DIR: rd, PREVIEW_RELAY_BIN: relayBin,
    });
    expect(r.code).toBe(0);
    expect(bodies[0]?.containerPort).toBe(3007);       // reuse of the existing relay
    await Bun.sleep(50);
    expect(existsSync(rec)).toBe(false);           // the relay bin was NOT started
  } finally { srv.stop(true); }
});

test("preview in a shared session: prints only the port, no URL", async () => {
  const srv = Bun.serve({ port: 0, fetch: () => Response.json({ publicPreview: true, port: 3002 }) });
  const procnet = writeProcnet([{ ip: ANY, port: 3002 }]);
  try {
    const r = await run(["3002"], { DEVD_SESSION_ID: "sess1", DEVD_URL: `http://127.0.0.1:${srv.port}`, PREVIEW_PROCNET: procnet });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("▸ the preview is shared — the guest opens it on the share page (port 3002)\n");
  } finally { srv.stop(true); }
});
