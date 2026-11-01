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

export interface AttachLoopDeps {
  retryRemoteErrors?: boolean; // cold recovery: docker/tmux may be starting while the row is running
  argv: string[];
  argvAlt?: string[]; // second network path to the same container (see dialFor); optional
  pathNames?: [string, string]; // path names [primary, fallback] for the "via …" message
  label: string; // "shop/Ledger-App · main-2" for messages
  run: (argv: string[]) => Promise<number>;
  sleep: (ms: number) => Promise<void>;
  health: () => Promise<"running" | "gone" | "unknown">;
  out?: (line: string) => void;
  now?: () => number; // injectable clock for tests; default Date.now
}

// Self-healing attach to a session: repeats `run(argv)` while the connection drops due to the network
// (ssh 255). Returns the final code for the caller: 0 (quiet detach / gave up after "gone"), 42 (F9 →
// menu) or an error code. A health check before each retry distinguishes "network down" (keep trying) from
// "container stopped" (give up with a clear message).
export async function attachLoop(deps: AttachLoopDeps): Promise<number> {
  const out = deps.out ?? ((l) => console.error(l));
  const now = deps.now ?? Date.now;
  let attempt = 0;
  for (;;) {
    const started = now();
    const code = await deps.run(dialFor(attempt, deps.argv, deps.argvAlt));
    const attachedMs = now() - started;
    const decision = retryDecision(code);
    if (decision === "done") return 0;
    if (decision === "exit-menu") return 42;
    if (decision === "error" && !(deps.retryRemoteErrors && [1, 44, 125, 126, 137, 143].includes(code))) {
      out(`Connection failed (code ${code}) — container is probably not running. Try \`dev\`.`);
      return code;
    }
    // "retry": tell a dropped network from a stopped container
    const state = await deps.health();
    if (state === "gone") {
      out(`Session ${deps.label} is no longer running (container stopped).`);
      return 0;
    }
    // After a successful (long enough) connection that then dropped, the attempt
    // counter is reset — see ATTACHED_RESET_MS above (spec §1).
    if (attachedMs >= ATTACHED_RESET_MS) attempt = 0;
    attempt++;
    const secs = Math.round(backoffMs(attempt) / 1000);
    // Path of the NEXT attempt (attempt is already incremented) — so the message shows that
    // routes alternate, not that we keep hammering on one in vain.
    const via = deps.argvAlt && deps.pathNames ? `, via ${deps.pathNames[attempt % 2]}` : "";
    out(`⏳ Disconnected from ${deps.label} — retrying in ${secs}s (attempt ${attempt}${via}). Ctrl-C = back.`);
    await deps.sleep(backoffMs(attempt));
  }
}
