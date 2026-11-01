import type { Database } from "bun:sqlite";
import { logEvent, type SessionRow } from "./db";

export interface PtyLike {
  onData(cb: (data: string) => void): void;
  onExit(cb: () => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}
export type SpawnPty = (container: string, sessionName: string, target: string, cols: number, rows: number) => PtyLike;

// The client protocol is EXCLUSIVELY JSON, so a keystroke cannot be confused with a control message.
// "s" = history scroll (n wheel steps), "b" = back to the end (exits tmux copy-mode);
// both pass even in read-only — it only looks, it writes nothing into the shell.
export type ClientMsg =
  | { t: "i"; d: string } | { t: "r"; cols: number; rows: number } | { t: "unlock" }
  | { t: "s"; d: "up" | "down"; n: number } | { t: "b" };

const MAX_SCROLL_STEPS = 20;
// The size from the client (even read-only) goes into the pty and into SGR coordinates — without a cap 1e22
// would become `5e+21` and tmux would write the sequence as text.
const MAX_DIM = 1000;
const clampDim = (v: number) => Math.min(MAX_DIM, Math.max(1, Math.trunc(v)));

export interface TerminalSink { send(data: string): void; close(): void }
export interface Bridge { onClientMessage(raw: string): void; dispose(): void }

export interface BridgeDeps {
  db: Database; sessionId: string; container: string; target: string;
  spawn: SpawnPty; sink: TerminalSink; cols: number; rows: number;
  // `tmux send-keys -t <name> -X cancel` in the container; name = this connection's grouped
  // session. Outside copy-mode tmux returns an error — the bridge swallows it.
  exitCopyMode?: (tmuxName: string) => Promise<void>;
  // The guest of a shared terminal (shareListener.ts) has control from the start — no
  // "Take control". Default false = the existing read-only start for the owner.
  granted?: boolean;
}

export function terminalGuard(s: SessionRow | null): { ok: true } | { ok: false; code: number; reason: string } {
  if (!s) return { ok: false, code: 1008, reason: "unknown session" };
  if (s.status !== "running") return { ok: false, code: 1008, reason: "session is not running" };
  return { ok: true };
}

// Target tmux session for the web terminal from the `?tmux` query: a valid name → itself, otherwise `main`.
export function terminalTarget(tmux: string | undefined, valid: (n: string) => boolean): string {
  return tmux && valid(tmux) ? tmux : "main";
}

// Unique name of the grouped tmux session per connection (Date/Math.random are not needed
// here — a simple per-process counter is enough and is deterministic).
let seq = 0;

export function createBridge(d: BridgeDeps): Bridge {
  const name = `web-${d.sessionId}-${++seq}`; // name of the grouped tmux session (see pty.ts)
  let granted = d.granted ?? false; // read-only until the client sends unlock (Take control)
  let size = { cols: d.cols, rows: d.rows }; // last known size → center for wheel events
  let cancelling = false; // {t:"b"} may have only one docker exec in flight (a read-only client would otherwise spawn without limit)
  const pty = d.spawn(d.container, name, d.target, d.cols, d.rows);
  pty.onData((data) => d.sink.send(data));
  pty.onExit(() => d.sink.close());
  logEvent(d.db, d.sessionId, "terminal_open", { container: d.container });

  return {
    onClientMessage(raw) {
      let msg: ClientMsg | undefined;
      try { msg = JSON.parse(raw) as ClientMsg; } catch { return; }
      if (!msg || typeof msg !== "object") return;
      switch (msg.t) {
        case "unlock":
          if (!granted) { granted = true; logEvent(d.db, d.sessionId, "terminal_control", { container: d.container }); }
          return;
        case "r":
          if (Number.isFinite(msg.cols) && Number.isFinite(msg.rows)) {
            size = { cols: clampDim(msg.cols), rows: clampDim(msg.rows) };
            pty.resize(size.cols, size.rows);
          }
          return;
        case "s": {
          // tmux (mouse on) takes the SGR wheel: 64 = up (enters copy-mode), 65 = down.
          // No logEvent — scroll arrives in dozens per second.
          if ((msg.d !== "up" && msg.d !== "down") || !Number.isInteger(msg.n) || msg.n < 1) return;
          const n = Math.min(msg.n, MAX_SCROLL_STEPS);
          const wheel = `\x1b[<${msg.d === "up" ? 64 : 65};${Math.ceil(size.cols / 2)};${Math.ceil(size.rows / 2)}M`;
          pty.write(wheel.repeat(n));
          return;
        }
        case "b":
          // Nothing is written into the pty (`q` outside copy-mode would be typed into the shell) — cancel via tmux.
          if (!d.exitCopyMode || cancelling) return;
          cancelling = true;
          (async () => {
            try { await d.exitCopyMode!(name); } catch { /* was not in copy-mode */ } finally { cancelling = false; }
          })();
          return;
        case "i":
          if (granted && typeof msg.d === "string") pty.write(msg.d);
          return;
      }
    },
    dispose() { try { pty.kill(); } catch { /* already dead */ } },
  };
}
