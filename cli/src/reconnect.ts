// Loop decision based on the exit code of the remote command (ssh → docker exec → bash → tmux attach):
//   0   = tmux detach (Ctrl-b d) or end of session → exit quietly (current behavior)
//   42  = user pressed F9 (EXIT_KEY) → exit menu on the mac
//   255 = ssh client error (network down, host unreachable) → retry
//   other (125/126 docker exec, 1, …) = container gone / unexpected → print and exit
export type RetryOutcome = "retry" | "exit-menu" | "done" | "error";

export function retryDecision(code: number): RetryOutcome {
  if (code === 0) return "done";
  if (code === 42) return "exit-menu";
  if (code === 255) return "retry";
  return "error";
}

// Backoff between reconnect attempts: 1→2→4→8 s, then capped at 15 s forever. attempt is 1-based.
export function backoffMs(attempt: number): number {
  return Math.min(15000, 1000 * 2 ** (attempt - 1));
}

// Threshold for resetting the attempt counter (spec §1): if `run(argv)` ran for at least
// this long, we were REALLY connected and then the network dropped — it was not the
// CONNECT itself that failed (that returns within ~ConnectTimeout, i.e. ~10 s). A long-connected
// session that drops (e.g. overnight with the lid closed) thus comes back after the drop
// at "attempt 1" / 1s backoff instead of staying stuck at the 15 s cap with hundreds
// of attempts in the message.
const ATTACHED_RESET_MS = 30000;

// Alternating network paths between attempts. The public IP and the tailnet are INDEPENDENT routes to the same
// server: on 2026-07-25 the mac's IPv4 path to the VPS stopped working (~4 min), while Tailscale
// between the same machines kept working over IPv6 — yet the loop kept dialing the dead public
// IP forever (each attempt 10 s until ConnectTimeout) and the session came back only when IPv4 recovered.
// Even attempt = primary path (so the first connect behaves as before), odd = fallback,
// so an outage of ONE route costs one extra attempt instead of the whole outage.
export function dialFor(attempt: number, argv: string[], argvAlt?: string[]): string[] {
  if (!argvAlt) return argv;
  return attempt % 2 === 0 ? argv : argvAlt;
}

// When ssh dies mid-attach, tmux never gets to undo what it switched on in the local terminal:
// mouse reporting (every move then prints `^[[<35;44;50M` garbage over the retry message —
// seen live 1 Nov 2026), bracketed paste, a hidden cursor, the alternate screen. Turned off here.
export const TERMINAL_RESET =
  "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1005l\x1b[?1006l\x1b[?1015l" + // mouse reporting
  "\x1b[?1004l" +                                                     // focus events (^[[I / ^[[O on every tab switch)
  "\x1b[?2004l" +                                                     // bracketed paste
  "\x1b[?1049l" +                                                     // leave the alternate screen
  "\x1b[?25h";                                                        // show the cursor

// What one attach attempt returned: the exit code plus the last line ssh/docker wrote to stderr
// (captured, not shown — see runAttach in attach.ts). A bare number is accepted for simple callers/tests.
export interface RunResult { code: number; error?: string }

// ssh failed BEFORE we were attached (TCP connect, DNS, handshake). Such an attempt can take longer than
// ATTACHED_RESET_MS (a stalled TCP connect ends with "Operation timed out" after ~75 s despite ConnectTimeout)
// and must not reset the attempt counter — 9 Nov 2026 the counter kept falling back to "attempt 1".
const CONNECT_FAILURE = /connect to host|could not resolve|network is unreachable|no route to host|connection refused|operation timed out|connection timed out|connection closed by|kex_exchange|banner exchange/i;
export const isConnectFailure = (error?: string): boolean => !!error && CONNECT_FAILURE.test(error);

// State of the offline panel; `null` = connected again / loop over → remove the panel.
export interface RetryStatus {
  label: string;
  phase: "waiting" | "connecting";
  attempt: number;
  secondsLeft: number;     // waiting only
  via?: string;            // network path of the next/current attempt
  lastError?: string;
  offlineSince: number;    // ms epoch of the first drop in this outage
}

export interface AttachLoopDeps {
  retryRemoteErrors?: boolean; // cold recovery: docker/tmux may be starting while the row is running
  argv: string[];
  argvAlt?: string[]; // second network path to the same container (see dialFor); optional
  pathNames?: [string, string]; // path names [primary, fallback] for the "via …" message
  label: string; // "shop/Ledger-App · main-2" for messages
  run: (argv: string[]) => Promise<number | RunResult>;
  sleep: (ms: number) => Promise<void>;
  health: () => Promise<"running" | "gone" | "unknown">;
  out?: (line: string) => void;
  /** In-place offline panel (TTY). When set, retries update it instead of printing a line per attempt. */
  status?: (s: RetryStatus | null) => void;
  now?: () => number; // injectable clock for tests; default Date.now
  resetTerminal?: () => void; // undo tmux's terminal modes after a dropped connection
}

// Self-healing attach to a session: repeats `run(argv)` while the connection drops due to the network
// (ssh 255). Returns the final code for the caller: 0 (quiet detach / gave up after "gone"), 42 (F9 →
// menu) or an error code. A health check before each retry distinguishes "network down" (keep trying) from
// "container stopped" (give up with a clear message).
export async function attachLoop(deps: AttachLoopDeps): Promise<number> {
  const out = deps.out ?? ((l) => console.error(l));
  const now = deps.now ?? Date.now;
  const status = deps.status;
  const via = (attempt: number) => (deps.argvAlt && deps.pathNames ? deps.pathNames[attempt % 2] : undefined);
  let attempt = 0;
  let offlineSince: number | null = null;
  let lastError: string | undefined;
  for (;;) {
    if (status && offlineSince !== null) {
      status({ label: deps.label, phase: "connecting", attempt, secondsLeft: 0, via: via(attempt), lastError, offlineSince });
    }
    const started = now();
    const raw = await deps.run(dialFor(attempt, deps.argv, deps.argvAlt));
    const { code, error } = typeof raw === "number" ? { code: raw, error: undefined } : raw;
    const ended = now();
    const attachedMs = ended - started;
    const decision = retryDecision(code);
    if (decision === "done") { status?.(null); return 0; }
    deps.resetTerminal?.();   // every other outcome may have left tmux's modes on
    if (decision === "exit-menu") { status?.(null); return 42; }
    if (decision === "error" && !(deps.retryRemoteErrors && [1, 44, 125, 126, 137, 143].includes(code))) {
      status?.(null);
      out(`Connection failed (code ${code}) — container is probably not running. Try \`dev\`.${error ? `\n  ${error}` : ""}`);
      return code;
    }
    // "retry": tell a dropped network from a stopped container
    const state = await deps.health();
    if (state === "gone") {
      status?.(null);
      out(`Session ${deps.label} is no longer running (container stopped).`);
      return 0;
    }
    // After a successful (long enough) connection that then dropped, the attempt
    // counter is reset — see ATTACHED_RESET_MS above (spec §1). A long attempt that never
    // got past the connect is not "attached" (isConnectFailure).
    if (attachedMs >= ATTACHED_RESET_MS && !isConnectFailure(error)) { attempt = 0; offlineSince = null; }
    offlineSince ??= ended;
    if (error) lastError = error;
    attempt++;
    const wait = backoffMs(attempt);
    if (!status) {
      // Path of the NEXT attempt (attempt is already incremented) — so the message shows that
      // routes alternate, not that we keep hammering on one in vain.
      const v = via(attempt);
      out(`⏳ Disconnected from ${deps.label} — retrying in ${Math.round(wait / 1000)}s (attempt ${attempt}${v ? `, via ${v}` : ""}). Ctrl-C = back.`);
      await deps.sleep(wait);
      continue;
    }
    // Panel: count down once per second instead of printing another line.
    for (let left = wait; left > 0; left -= 1000) {
      status({ label: deps.label, phase: "waiting", attempt, secondsLeft: Math.ceil(left / 1000), via: via(attempt), lastError, offlineSince });
      await deps.sleep(Math.min(1000, left));
    }
  }
}

// ---- Offline panel rendering -------------------------------------------------------------------

const SPIN = ["◜", "◝", "◞", "◟"];

function ago(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** "ssh: connect to host 1.2.3.4 port 2222: Operation timed out" → "1.2.3.4:2222 — operation timed out". */
export function prettyError(e: string): string {
  const m = /connect to host (\S+) port (\d+): (.+)$/i.exec(e);
  if (m) return `${m[1]}:${m[2]} — ${m[3]!.charAt(0).toLowerCase()}${m[3]!.slice(1)}`;
  return e.replace(/^ssh:\s*/i, "");
}

function fit(s: string, width: number): string {
  const chars = [...s];
  return chars.length <= width ? s : chars.slice(0, Math.max(1, width - 1)).join("") + "…";
}

/** Plain-text lines of the panel; `frame` drives the spinner. Pure, so it is unit-tested. */
export function renderRetryStatus(s: RetryStatus, now: number, frame: number, width = 100): string[] {
  const spin = SPIN[frame % SPIN.length];
  const path = s.via ? ` via ${s.via}` : "";
  const lines = [
    `${spin} Offline · ${s.label}`,
    s.phase === "connecting"
      ? `  connecting${path}…  (attempt ${s.attempt})`
      : `  reconnecting in ${s.secondsLeft}s${path}  (attempt ${s.attempt})`,
  ];
  if (s.lastError) lines.push(`  ${prettyError(s.lastError)}`);
  lines.push(`  offline for ${ago(now - s.offlineSince)} · Ctrl-C = back`);
  return lines.map((l) => fit(l, Math.max(20, width - 1)));
}

const C = { title: "\x1b[1;33m", dim: "\x1b[2m", reset: "\x1b[0m" };

/** Draws the panel in place: every update erases the previous one (cursor up + clear to end),
 *  so an outage stays a few lines high instead of scrolling two lines per attempt. */
export function createStatusPanel(write: (s: string) => void, opts: { width?: () => number; now?: () => number; color?: boolean } = {}) {
  let drawn = 0;
  let frame = 0;
  const color = opts.color ?? true;
  const erase = () => (drawn ? `\r\x1b[${drawn}A\x1b[J` : "");
  return (s: RetryStatus | null): void => {
    if (!s) {
      if (drawn) write(erase() + "\x1b[?25h");
      drawn = 0;
      return;
    }
    const lines = renderRetryStatus(s, (opts.now ?? Date.now)(), frame++, opts.width?.() ?? 100);
    const body = lines.map((l, i) => (color ? (i === 0 ? C.title : C.dim) + l + C.reset : l)).join("\n") + "\n";
    write(erase() + "\x1b[?25l" + body);
    drawn = lines.length;
  };
}
