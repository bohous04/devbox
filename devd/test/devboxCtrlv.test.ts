// devbox-ctrlv: tmux binding for Ctrl+V in the container. cc reads the clipboard via the xclip shim,
// but Codex and Grok Build use arboard (X11/Wayland directly) and without a display server
// their Ctrl+V silently fails. So for a codex/grok pane the binding stages the image into the
// shared /inbox and pastes the path (bracketed paste = the same as drag&drop, which both TUIs
// attach as an image); for claude and everything else it just forwards C-v to the pane.
//
// The test runs the real script with fake `tmux` and `ps` on PATH (they log their arguments) and real
// curl against a Bun.serve devd stub — same pattern as xclipShim.test.ts.
import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "..", "image", "devbox-ctrlv");

function fakeBin(procs: string) {
  const dir = mkdtempSync(join(tmpdir(), "ctrlv-"));
  const log = join(dir, "log");
  writeFileSync(log, "");
  // display-message returns the pane tty; load-buffer reads stdin (the content of the future paste)
  writeFileSync(join(dir, "tmux"), `#!/bin/sh
echo "tmux $*" >> "$CTRLV_LOG"
case "$1" in
  display-message) echo /dev/pts/9 ;;
  load-buffer) cat >> "$CTRLV_LOG.buffer" ;;
esac
`);
  writeFileSync(join(dir, "ps"), `#!/bin/sh
printf '%s\\n' "$CTRLV_PROCS"
`);
  chmodSync(join(dir, "tmux"), 0o755);
  chmodSync(join(dir, "ps"), 0o755);
  return { dir, log, env: { PATH: `${dir}:${process.env.PATH}`, CTRLV_LOG: log, CTRLV_PROCS: procs } };
}

// async Bun.spawn — spawnSync would block the thread the Bun.serve stub runs on (deadlock)
async function run(env: Record<string, string>) {
  const p = Bun.spawn(["sh", SCRIPT, "%1"], { env: { ...process.env, ...env }, stdout: "ignore", stderr: "ignore" });
  return await p.exited;
}

function tmuxCalls(log: string): string[] {
  return readFileSync(log, "utf8").split("\n").filter(Boolean);
}

test("devbox-ctrlv: claude pane → C-v is forwarded natively (xclip shim), devd is not called", async () => {
  const hits: string[] = [];
  const srv = Bun.serve({ port: 0, fetch(req) { hits.push(new URL(req.url).pathname); return new Response("x"); } });
  const { log, env } = fakeBin("zsh\nclaude\nnode");
  try {
    await run({ ...env, DEVD_URL: `http://localhost:${srv.port}` });
    expect(tmuxCalls(log)).toEqual([
      "tmux display-message -p -t %1 #{pane_tty}",
      "tmux send-keys -t %1 C-v",
    ]);
    expect(hits).toEqual([]);
  } finally { srv.stop(true); }
});

test("devbox-ctrlv: other pane (bash/vim) → C-v is forwarded, no bridge", async () => {
  const { log, env } = fakeBin("bash\nvim");
  await run({ ...env, DEVD_URL: "http://localhost:1" });
  expect(tmuxCalls(log)).toContain("tmux send-keys -t %1 C-v");
  expect(existsSync(`${log}.buffer`)).toBe(false);
});

test("devbox-ctrlv: grok + image on the clipboard → stage into /inbox and bracketed paste of the path", async () => {
  const hits: string[] = [];
  const srv = Bun.serve({
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      hits.push(u.pathname + u.search);
      if (u.pathname === "/api/clipboard/targets") return new Response("image/png\ntext/plain\n");
      if (u.pathname === "/api/clipboard/image") return new Response("/inbox/img-20260823-120000.png");
      return new Response(null, { status: 404 });
    },
  });
  const { log, env } = fakeBin("zsh\ngrok");
  try {
    await run({ ...env, DEVD_URL: `http://localhost:${srv.port}`, DEVD_SESSION_ID: "s1" });
    expect(hits).toEqual([
      "/api/clipboard/targets?session=s1",
      "/api/clipboard/image?target=shared&session=s1",
    ]);
    expect(readFileSync(`${log}.buffer`, "utf8")).toBe("/inbox/img-20260823-120000.png");
    const calls = tmuxCalls(log);
    expect(calls).toContain("tmux load-buffer -b devbox-ctrlv -");
    expect(calls).toContain("tmux paste-buffer -p -d -b devbox-ctrlv -t %1");
    expect(calls).not.toContain("tmux send-keys -t %1 C-v");
  } finally { srv.stop(true); }
});

// codex shows up in the pane as `node` (npm wrapper) — but the native `codex` binary sits
// on the same tty, so detection goes through the process list, not pane_current_command.
test("devbox-ctrlv: codex (node wrapper) + file on the clipboard → /file, the Finder icon does not take precedence", async () => {
  const hits: string[] = [];
  const srv = Bun.serve({
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      hits.push(u.pathname + u.search);
      // Finder also bundles a preview icon onto the clipboard → targets offers file AND image;
      // file must win, otherwise the icon gets pasted (same trap as in hammerspoon).
      if (u.pathname === "/api/clipboard/targets") return new Response("application/x-devbox-file\nimage/png\ntext/plain\n");
      if (u.pathname === "/api/clipboard/file") return new Response("/inbox/invoice.pdf");
      return new Response(null, { status: 404 });
    },
  });
  const { log, env } = fakeBin("node\ncodex");
  try {
    await run({ ...env, DEVD_URL: `http://localhost:${srv.port}` });
    expect(hits).toEqual(["/api/clipboard/targets", "/api/clipboard/file?target=shared"]);
    expect(readFileSync(`${log}.buffer`, "utf8")).toBe("/inbox/invoice.pdf");
  } finally { srv.stop(true); }
});

test("devbox-ctrlv: text on the clipboard → bracketed paste of the text (physical Ctrl+V in codex/grok)", async () => {
  const srv = Bun.serve({
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === "/api/clipboard/targets") return new Response("text/plain\n");
      if (u.pathname === "/api/clipboard/text") return new Response("hello world");
      return new Response(null, { status: 404 });
    },
  });
  const { log, env } = fakeBin("grok");
  try {
    await run({ ...env, DEVD_URL: `http://localhost:${srv.port}` });
    expect(readFileSync(`${log}.buffer`, "utf8")).toBe("hello world");
  } finally { srv.stop(true); }
});

// Locked vault / sleeping mac: targets degrades to "text/plain", /text returns 503
// with a message — it gets pasted into the prompt, same UX as the xclip shim (no silent failure).
test("devbox-ctrlv: unavailable clipboard → the 503 message is pasted instead of failing silently", async () => {
  const srv = Bun.serve({
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === "/api/clipboard/targets") return new Response("text/plain\n");
      if (u.pathname === "/api/clipboard/text") return new Response("WARNING: vault is locked", { status: 503 });
      return new Response(null, { status: 404 });
    },
  });
  const { log, env } = fakeBin("grok");
  try {
    await run({ ...env, DEVD_URL: `http://localhost:${srv.port}` });
    expect(readFileSync(`${log}.buffer`, "utf8")).toContain("vault is locked");
  } finally { srv.stop(true); }
});

test("devbox-ctrlv: empty clipboard (204) and missing DEVD_URL → C-v is forwarded", async () => {
  const srv = Bun.serve({
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === "/api/clipboard/targets") return new Response("text/plain\n");
      return new Response(null, { status: 204 });
    },
  });
  const a = fakeBin("grok");
  const b = fakeBin("grok");
  try {
    await run({ ...a.env, DEVD_URL: `http://localhost:${srv.port}` });
    expect(tmuxCalls(a.log)).toContain("tmux send-keys -t %1 C-v");
    expect(existsSync(`${a.log}.buffer`)).toBe(false);
    await run({ ...b.env, DEVD_URL: "" });
    expect(tmuxCalls(b.log)).toContain("tmux send-keys -t %1 C-v");
  } finally { srv.stop(true); }
});
