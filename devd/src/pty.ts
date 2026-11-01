import { existsSync } from "fs";
import { join } from "path";
import { run as runProc, timeoutFor } from "./proc";
import { dockerArgv } from "./dockerTarget";
import type { PtyLike, SpawnPty } from "./terminal";

// Auto-heal for old containers: a container built from an image BEFORE
// `image/devbox-pty` was added lacks the binary, so `docker exec … devbox-pty …` fails with
// exit 127 → the PTY dies immediately → the web terminal just silently "disconnects". Before
// starting the PTY we check that it is present and, if missing, copy the script inside (it is a
// pure Python-stdlib script and python3 has always been in the image). Idempotent, non-blocking
// on error: without a source we let exec fail as before.
const IN_CONTAINER_PTY = "/usr/local/bin/devbox-pty";
// devd runs unbundled (`bun <repo>/devd/src/index.ts`), so this points to
// <repo>/image/devbox-pty — the same path pty.test.ts uses.
const DEVBOX_PTY_SRC = join(import.meta.dir, "..", "..", "image", "devbox-pty");

export interface PtyRunner {
  run(cmd: string[]): { exitCode: number } | Promise<{ exitCode: number }>;
  exists(path: string): boolean;
}
const realRunner: PtyRunner = {
  run: async (cmd) => ({ exitCode: (await runProc(cmd, { timeoutMs: timeoutFor("DOCKER_QUERY") })).code }),
  exists: (p) => existsSync(p),
};

export async function ensureDevboxPty(container: string, src = DEVBOX_PTY_SRC, r: PtyRunner = realRunner): Promise<void> {
  if ((await r.run([...dockerArgv(container), "exec", container, "test", "-x", IN_CONTAINER_PTY])).exitCode === 0) return;
  if (!r.exists(src)) return; // no source → let exec fail as before (no regression)
  await r.run([...dockerArgv(container), "cp", src, `${container}:${IN_CONTAINER_PTY}`]);
  await r.run([...dockerArgv(container), "exec", "-u", "0", container, "chmod", "755", IN_CONTAINER_PTY]);
}

// Protocol frame for the in-container bridge `devbox-pty` (image/devbox-pty):
// [type:1B]['len:4B big-endian][payload]. 'i' = keystrokes into the PTY, 'r' = "cols,rows".
export function frame(type: "i" | "r", payload: string): Uint8Array {
  const body = new TextEncoder().encode(payload);
  const out = new Uint8Array(5 + body.length);
  out[0] = type.charCodeAt(0);
  new DataView(out.buffer).setUint32(1, body.length, false); // big-endian
  out.set(body, 5);
  return out;
}

// Grouped tmux session: `new-session -t <target> -s <name>` shares windows/panes with the target
// session (the live agent) but has its own size; `destroy-unattached on` kills it when the
// WS disconnects. `-A -d -s <target>` first makes sure the target exists. Launcher without an
// argument = agent-launch picks the container's default ($DEVD_AGENT). Fallback to
// `claude-launch`, same reason as `cli/src/attach.ts launchCmd`: the web terminal can also
// create a not-yet-existing `main-N` on a container from an OLD image (without
// agent-launch) — without the fallback `-A` would fail with exit 127 and the session would die.
export function tmuxCmd(name: string, target: string): string {
  const launch = "-c /workspace sh -lc 'if [ -x /usr/local/bin/agent-launch ]; then exec /usr/local/bin/agent-launch; else exec /usr/local/bin/claude-launch; fi'";
  return `tmux new-session -A -d -s ${target} ${launch}; tmux new-session -t ${target} -s ${name} \\; set-option destroy-unattached on`;
}

// The PTY is allocated INSIDE the container (`devbox-pty`, Python stdlib pty — reliable on
// Linux). The host (devd under Bun) only pipes frames through `docker exec -i` (no -t, so
// no host TTY needed; node-pty does not work under Bun). Independent of the host OS.
export const realSpawnPty: SpawnPty = (container, name, target, cols, rows) => {
  type Sink = { write: (u: Uint8Array) => void; flush?: () => void };
  // ref objects (not `let`) for narrowing in the nested closure; onData is set later
  const out: { cb: ((d: string) => void) | null; pending: string } = { cb: null, pending: "" };
  const exitCbs: (() => void)[] = [];
  const queue: Uint8Array[] = [];
  let sink: Sink | null = null;
  let closed = false;

  const send = (type: "i" | "r", payload: string) => {
    const f = frame(type, payload);
    if (!sink) { queue.push(f); return; } // process not running yet → queue it
    try { sink.write(f); sink.flush?.(); } catch { /* stdin closed */ }
  };

  // ensureDevboxPty is async (docker via proc.run), but SpawnPty must return a
  // PtyLike immediately: createBridge uses it synchronously. So the process is only started
  // after ensure, and keystrokes/resize are queued in the meantime (see `send` above).
  ensureDevboxPty(container).catch(() => { /* without a source let exec fail as before */ }).then(() => {
    if (closed) return; // kill() arrived before setup finished — do not spawn
    const proc = Bun.spawn([...dockerArgv(container), "exec", "-e", "TERM=xterm-256color", "-i", container, "devbox-pty", "bash", "-lc", tmuxCmd(name, target)], {
      stdin: "pipe", stdout: "pipe", stderr: "ignore",
    });
    sink = proc.stdin as unknown as Sink;
    for (const f of queue.splice(0)) { try { sink.write(f); sink.flush?.(); } catch { /* stdin closed */ } } // drain the queue in the correct order
    (async () => {
      const dec = new TextDecoder();
      try {
        for await (const chunk of proc.stdout as unknown as AsyncIterable<Uint8Array>) {
          const s = dec.decode(chunk);
          if (out.cb) out.cb(s); else out.pending += s;
        }
      } catch { /* stream closed */ }
    })();
    proc.exited.then(() => { for (const cb of exitCbs) cb(); });
    killer = () => { try { proc.kill(); } catch { /* already exited */ } };
  }).catch((e) => {
    // This `.catch` is NOT part of the chain on `ensureDevboxPty` above (that one
    // covers only its own error) — it is attached AFTER `.then()`, so it
    // also catches a synchronous throw FROM INSIDE it (typically `Bun.spawn` when
    // `docker` has meanwhile vanished from PATH — e.g. during its upgrade). Without this
    // catch it would be an unhandled rejection and Bun would terminate
    // the whole devd on it, not just this terminal. The bridge thus gets an exit
    // (closes cleanly) instead of taking the whole daemon down with it.
    console.error("failed to start devbox-pty:", e);
    for (const cb of exitCbs) cb();
  });
  let killer: () => void = () => { closed = true; }; // kill() before the process starts only prevents the spawn above
  // In this case `exitCbs` are NEVER called (the spawn is skipped, so `onExit`
  // hears nothing) — harmless, because the only caller of `kill()` is `dispose()`
  // from the websocket close handler (see terminal.ts), where `sink.close()` on an
  // already-closing socket would be pointless anyway.

  send("r", `${cols},${rows}`); // initial window size
  return {
    onData: (cb) => { out.cb = cb; if (out.pending) { cb(out.pending); out.pending = ""; } },
    onExit: (cb) => { exitCbs.push(cb); },
    write: (data) => send("i", data),
    resize: (c, r) => send("r", `${c},${r}`),
    kill: () => { closed = true; killer(); },
  };
};
