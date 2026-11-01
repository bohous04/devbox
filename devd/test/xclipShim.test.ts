import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SHIM = join(import.meta.dir, "..", "..", "image", "xclip");

// async Bun.spawn — spawnSync would block the thread the Bun.serve stub runs on (deadlock)
async function run(args: string[], env: Record<string, string>) {
  const p = Bun.spawn(["sh", SHIM, ...args], { env: { ...process.env, ...env }, stdout: "pipe", stderr: "ignore" });
  const code = await p.exited;
  const buffer = await new Response(p.stdout).arrayBuffer();
  const stdout = Buffer.from(buffer).toString("binary");
  return { code, stdout };
}

test("xclip shim maps -t to bridge endpoints and streams the body", async () => {
  const hits: string[] = [];
  const srv = Bun.serve({
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      hits.push(u.pathname + u.search);
      if (u.pathname === "/api/clipboard/targets") return new Response("image/png\ntext/plain\n");
      if (u.pathname === "/api/clipboard/image") return new Response(new Uint8Array([137, 80, 78, 71]));
      if (u.pathname === "/api/clipboard/text") return new Response(null, { status: 204 });
      return new Response(null, { status: 404 });
    },
  });
  const env = { DEVD_URL: `http://localhost:${srv.port}`, DEVD_SESSION_ID: "sess1" };
  try {
    const t = await run(["-selection", "clipboard", "-t", "TARGETS", "-o"], env);
    expect(t.code).toBe(0);
    expect(t.stdout).toBe("image/png\ntext/plain\n");
    const i = await run(["-selection", "clipboard", "-t", "image/png", "-o"], env);
    expect(i.code).toBe(0);
    expect(i.stdout).toBe("\x89PNG");
    expect((await run(["-selection", "clipboard", "-t", "text/plain", "-o"], env)).code).toBe(1); // 204 → exit 1
    expect((await run(["-selection", "clipboard", "-t", "image/bmp", "-o"], env)).code).toBe(1); // unsupported type
    expect((await run(["-selection", "clipboard", "-t", "TARGETS"], env)).code).toBe(1); // without -o (copy direction) → exit 1
    expect(hits).toEqual([
      "/api/clipboard/targets?session=sess1",
      "/api/clipboard/image?session=sess1",
      "/api/clipboard/targets?session=sess1", // text/plain checks targets first
      "/api/clipboard/text?session=sess1",
    ]);
  } finally { srv.stop(true); }
});

test("xclip shim: file on the clipboard → text/plain downloads /file and returns the container path", async () => {
  const hits: string[] = [];
  const srv = Bun.serve({
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      hits.push(u.pathname);
      if (u.pathname === "/api/clipboard/targets") return new Response("application/x-devbox-file\ntext/plain\n");
      if (u.pathname === "/api/clipboard/file") return new Response("/workspace/.inbox/faktura.pdf");
      return new Response(null, { status: 404 });
    },
  });
  const env = { DEVD_URL: `http://localhost:${srv.port}`, DEVD_SESSION_ID: "s" };
  try {
    // cc reads TARGETS (file + text/plain) → then text/plain
    const t = await run(["-t", "TARGETS", "-o"], env);
    expect(t.stdout).toBe("application/x-devbox-file\ntext/plain\n");
    const x = await run(["-t", "text/plain", "-o"], env);
    expect(x.code).toBe(0);
    expect(x.stdout).toBe("/workspace/.inbox/faktura.pdf");
    expect(hits).toContain("/api/clipboard/file");
  } finally { srv.stop(true); }
});

test("xclip shim: 413 from /file is pasted as text (the message)", async () => {
  const srv = Bun.serve({
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === "/api/clipboard/targets") return new Response("application/x-devbox-file\ntext/plain\n");
      // ASCII fixture: run() decodes stdout as latin1 (because of PNG bytes) → multibyte UTF-8 would break the assertion
      if (u.pathname === "/api/clipboard/file") return new Response("NOTE: file is too big", { status: 413 });
      return new Response(null, { status: 404 });
    },
  });
  const env = { DEVD_URL: `http://localhost:${srv.port}` };
  try {
    const x = await run(["-t", "text/plain", "-o"], env);
    expect(x.code).toBe(0);
    expect(x.stdout).toContain("too big");
  } finally { srv.stop(true); }
});

test("xclip shim without DEVD_URL fails", async () => {
  expect((await run(["-t", "TARGETS", "-o"], { DEVD_URL: "" })).code).toBe(1);
});

// 503 = clipboard unavailable (locked vault / sleeping Mac). It used to be 502 → exit 1
// → cc stayed silent. Now the body is pasted into the prompt so it is visible WHY the image did not upload.
test("xclip shim: 503 pastes the message instead of failing silently and flashes in tmux", async () => {
  const srv = Bun.serve({
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      // ASCII fixture: run() decodes stdout as latin1 (see above)
      if (u.pathname === "/api/clipboard/targets") return new Response("text/plain\n");
      return new Response("NOTE: vault is locked", { status: 503 });
    },
  });
  // tmux stub: writes its arguments so we can verify the banner really fires
  const dir = mkdtempSync(join(tmpdir(), "xclip-tmux-"));
  const log = join(dir, "args");
  writeFileSync(join(dir, "tmux"), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${log}\n`, { mode: 0o755 });
  const env = { DEVD_URL: `http://localhost:${srv.port}`, TMUX: "/tmp/fake,1,0", PATH: `${dir}:${process.env.PATH}` };
  try {
    const t = await run(["-t", "text/plain", "-o"], env);
    expect(t.code).toBe(0);
    expect(t.stdout).toContain("vault is locked");
    expect(readFileSync(log, "utf8")).toContain("display-message");
    // the image asks for the message too (in case cc skipped targets)
    const i = await run(["-t", "image/png", "-o"], env);
    expect(i.code).toBe(0);
    expect(i.stdout).toContain("vault is locked");
  } finally { srv.stop(true); rmSync(dir, { recursive: true, force: true }); }
});
