// devd/src/proc.ts
// The only way devd spawns subprocesses. devd has a single thread: a synchronous
// Bun.spawnSync stops the HTTP server, the lease of starting sessions, hooks and timers
// for the whole run of the child (incident 2026-09-03: a neighbor's recreate blocked
// account-lease → session outside the pool). Here we wait asynchronously, with a hard
// timeout (SIGKILL) and without exceptions due to the child's result — the caller reads `code`.
// A command that backgrounds its own descendant inheriting stdout/stderr
// (`cmd & exit 0` etc.) is still cut off at the timeout budget — `run()` always
// returns, but the output may then be incomplete (the grandchild is not killed, Bun cannot
// spawn into its own process group).

import { hardenGit, isGitArgv } from "./safeGit";

export interface RunResult { code: number; stdout: string; stderr: string; timedOut: boolean }
export interface RunOpts {
  cwd?: string;
  env?: Record<string, string>;
  /** Remove these names after merging env, only in this child's environment. */
  unsetEnv?: readonly string[];
  stdin?: string;
  timeoutMs: number;
  /** Incremental chunks of stderr as they arrive (e.g. `git clone --progress`). The final
   *  `stderr` is still complete — this is only a preview while running. */
  onStderr?: (chunk: string) => void;
}

export type TimeoutGroup = "DOCKER_LIFECYCLE" | "DOCKER_QUERY" | "GIT_NET" | "GIT_CLONE" | "LOCAL" | "BACKUP" | "NET_CLI" | "SSH_AGENT";

// Default caps per group (see spec §3.5). Env `DEVD_TIMEOUT_<GROUP>_MS` overrides.
export const TIMEOUTS: Record<TimeoutGroup, number> = {
  DOCKER_LIFECYCLE: 60_000,
  DOCKER_QUERY: 15_000,
  GIT_NET: 600_000,
  // The initial clone of a large repo (~200k objects, over 8 GB) takes longer
  // than the 10 min of GIT_NET — after a SIGKILL the user would wait and get nothing.
  GIT_CLONE: 3_600_000,
  LOCAL: 300_000,
  BACKUP: 1_800_000,
  NET_CLI: 30_000,
  SSH_AGENT: 15_000,
};

export function timeoutFor(group: TimeoutGroup): number {
  const raw = process.env[`DEVD_TIMEOUT_${group}_MS`];
  const n = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? n : TIMEOUTS[group];
}

// Soft threshold: a command running longer logs a warning with argv (without env) and duration —
// next time nobody has to dig up what devd was holding. Env for tests.
export const SLOW_WARN_MS = 5_000;
const slowWarnMs = () => {
  const n = Number.parseInt(process.env.DEVD_SLOW_WARN_MS ?? "", 10);
  return Number.isInteger(n) && n > 0 ? n : SLOW_WARN_MS;
};

// `docker run` gets secret variables as argv (`-e DEVD_UPSTREAM_KEY=…`, see
// runContainer in docker.ts and proxyEnv in sessions.ts) — without redaction the warning
// about a slow subprocess below would send live API keys into the journal (`journalctl -u
// devd` is retained and readable by anyone with host access). The decision is made ONLY
// by variable name, not by position after `-e`/`--env` — `-e DEVD_AGENT=claude`
// stays readable in the log, because "AGENT" is not a secret name; conversely `GITHUB_TOKEN=x`
// is hidden even if it appears outside `-e` in the future.
// The secret word must be a WHOLE `_`-separated component of the name, not an arbitrary
// substring — otherwise `StrictHostKeyChecking=no` (contains "Key") or
// `monkey=x` (contains "key") would end up the same as a real secret (review finding).
// `S?` at the end of the word: the plural (`DEVD_GITEA_TOKENS`, `AWS_SECRET_ACCESS_KEYS`)
// is still a whole component, not a substring — it must be masked the same as the singular
// (review finding).
const SECRET_ENV_NAME =
  /^(?:[A-Z0-9]+_)*(?:KEY|APIKEY|TOKEN|SECRET|PASS|PASSWD|PASSWORD|PASSPHRASE|AUTH|CREDENTIALS)S?(?:_[A-Z0-9]+)*=/i;

// git clone may get a URL with a token, so userinfo is masked too (`user:pass@`
// and a bare `token@`) — `[^/\s@]+` stops at the first `/`, so the repo path after the
// host stays readable in the log and a URL without userinfo is unchanged.
const URL_USERINFO = /:\/\/[^/\s@]+@/g;
export function redactArgv(cmd: string[]): string[] {
  return cmd.map((a) => {
    const envMasked = SECRET_ENV_NAME.test(a) ? a.replace(/=.*/, "=***") : a;
    return envMasked.replace(URL_USERINFO, "://***@");
  });
}

/** Every `git` goes through safeGit.ts (rereview N3): a session repo is untrusted input and
 *  devd runs as root. Other commands unchanged. */
export async function run(cmd: string[], opts: RunOpts): Promise<RunResult> {
  if (!cmd.length) throw new Error("run(): empty argv");
  if (!isGitArgv(cmd)) return runRaw(cmd, opts);
  const h = await hardenGit(cmd, opts, runRaw);
  return "result" in h ? h.result : runRaw(h.cmd, h.opts);
}

/** Spawn without modifications — only for run() and safeGit (reading config before git). */
export async function runRaw(cmd: string[], opts: RunOpts): Promise<RunResult> {
  if (!cmd.length) throw new Error("run(): empty argv");
  let p: ReturnType<typeof Bun.spawn>;
  try {
    const childEnv = { ...process.env, ...(opts.env ?? {}) };
    for (const name of opts.unsetEnv ?? []) delete childEnv[name];
    p = Bun.spawn(cmd, {
      cwd: opts.cwd,
      stdout: "pipe", stderr: "pipe",
      stdin: opts.stdin === undefined ? "ignore" : "pipe",
      // Bun without `env` takes the environment from the snapshot at process start, so
      // run() would not see changes to process.env (PATH in tests, tokens set at
      // runtime) — hence we always explicitly merge the live process.env, never `undefined`.
      env: childEnv,
    });
  } catch (e) {
    // Missing binary: Bun.spawn throws synchronously. 127 = the shell convention for
    // "command not found", same as sshAgent.defaultRun today.
    return { code: 127, stdout: "", stderr: e instanceof Error ? e.message : String(e), timedOut: false };
  }
  if (opts.stdin !== undefined) {
    const sink = p.stdin as unknown as { write: (s: string) => void; end: () => void };
    sink.write(opts.stdin);
    sink.end();
  }

  // Read incrementally into a string via an explicit reader (not `new Response(stream)
  // .text()` and not `for await` directly on the stream) — only a reader can be cancelled from outside,
  // whereas on the stream itself `for await` holds the lock and its `.cancel()` always
  // ends in a promise rejected with "locked". Thanks to the reader, after the budget is exhausted
  // we can return what has been read SO FAR and close the pipe correctly —
  // instead of waiting for an EOF which, after a SIGKILL (or for a child that left its
  // own descendant running in the background), may never come.
  let stdoutBuf = "";
  let stderrBuf = "";
  const stdoutReader = (p.stdout as ReadableStream<Uint8Array>).getReader();
  const stderrReader = (p.stderr as ReadableStream<Uint8Array>).getReader();
  // After the budget is exhausted (see the race below) `stdoutDone`/`stderrDone` are no
  // longer awaited — if the orphan never finishes, they stay pending forever, which is
  // fine. But if they later FAIL (read error from a cancelled/closed pipe),
  // that must not be an uncaught rejection without a listener — hence `drain` swallows the
  // error itself.
  // `drain` takes the reader structurally (only `.read()` returning `{done, value}`),
  // not by the named type `ReadableStreamDefaultReader<Uint8Array>` — Bun's
  // global types and `node:stream/web` (@types/node) declare the same-named type
  // incompatibly with each other (Bun additionally requires `readMany`), so the named
  // annotation clashed with what `p.stdout.getReader()` actually returns.
  const drain = async (
    reader: { read(): Promise<{ done?: boolean; value?: Uint8Array }> },
    onChunk: (s: string) => void,
  ) => {
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done || value === undefined) break;
        onChunk(decoder.decode(value, { stream: true }));
      }
      // Empty input + `stream: false` (default) = call the final flush of an
      // unfinished multi-byte sequence. `.decode()` without arguments does not work here —
      // the types from `node:stream/web` (unlike the DOM lib) make it mandatory.
      onChunk(decoder.decode(new Uint8Array(0)));
    } catch { /* cancelled/closed pipe — the unfinished remainder is discarded */ }
  };
  // Reading must start CONCURRENTLY with waiting for exit, not after it: an undrained
  // pipe would fill the OS buffer with longer output and the child would get stuck writing,
  // so `p.exited` would never come.
  // An exception from the preview must not end the drain — an undrained pipe would block the child.
  const notifyStderr = (s: string) => { try { opts.onStderr?.(s); } catch { /* preview only */ } };
  const stdoutDone = drain(stdoutReader, (s) => { stdoutBuf += s; });
  const stderrDone = drain(stderrReader, (s) => { stderrBuf += s; if (s) notifyStderr(s); });

  let timedOut = false;
  const started = Date.now();
  const timer = setTimeout(() => { timedOut = true; try { p.kill("SIGKILL"); } catch { /* already exited */ } }, opts.timeoutMs);
  try {
    const code = await p.exited;
    // The immediate child has already exited (by itself, or after the SIGKILL from the timer above) —
    // `timedOut` is now frozen. The timer is cleared RIGHT here, not in `finally`:
    // otherwise it would stay armed for the whole wait on the pipes below and could
    // fire just before `run()` returns even for a child that exited long before
    // `timeoutMs` — the reader would then get `timedOut: true` for a process that
    // never timed out, it just had a (background) descendant with a slow/absent pipe.
    clearTimeout(timer);
    // Even after a NORMAL exit of the child, its own descendant may have been left hanging
    // in the background (typically a shell script with `cmd & exit 0`, or a script where
    // the last command is NOT a tail call, so the shell forks it instead of exec) —
    // such an orphan inherits stdout/stderr and keeps the pipes open, so waiting for
    // EOF would hang forever even though `run()` itself is already "done". SIGKILL
    // (on the timeout branch) only goes to the immediate child — Bun cannot
    // spawn into its own process group, so targeting the whole group is not possible
    // — the orphan is not killed, we just stop waiting for its pipe. The budget for
    // finishing the read is therefore bounded on BOTH branches: after a timeout a short 100 ms
    // (the child is dead, nothing more will arrive), otherwise the rest of `timeoutMs` (from
    // the start, not from now) with a floor of 100 ms (so the drain gets at least a moment even for
    // very short commands). The guarantee is "devd does not block", not "the grandchild dies" —
    // the output may then be partial.
    const budgetMs = timedOut ? 100 : Math.max(100, opts.timeoutMs - (Date.now() - started));
    // `Bun.sleep(budgetMs)` could not be cancelled here — even after the other branch of the race wins,
    // its internal timer would stay alive (and referenced, i.e. holding the event loop)
    // until it elapses on its own. For a fast command with a long timeout (GIT_NET
    // 600 s, BACKUP 1800 s) this measurably keeps the process awake for that whole time even after
    // returning from run() — hence our own setTimeout, whose handle can be cleared after the race.
    let budgetTimer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all([stdoutDone, stderrDone]),
      new Promise<void>((r) => { budgetTimer = setTimeout(r, budgetMs); }),
    ]);
    clearTimeout(budgetTimer);
    // Cancel goes to the READER (not the stream) — the stream itself would still be locked
    // after `for await`/`getReader()` and `.cancel()` would always end in a
    // promise rejected with "ReadableStream is locked". `reader.cancel()` is
    // legal even with the lock, and the read inside `drain()` then gets `done:
    // true`. `.cancel()` returns a promise (not a synchronous exception), hence `await`
    // inside try — otherwise an uncaught rejection would escape outside this request.
    try { await stdoutReader.cancel(); } catch { /* already done/closed */ }
    try { await stderrReader.cancel(); } catch { /* already done/closed */ }
    const took = Date.now() - started;
    if (took > slowWarnMs()) console.warn(`slow subprocess (${(took / 1000).toFixed(1)} s): ${redactArgv(cmd).join(" ")}`);
    return { code: code ?? 1, stdout: stdoutBuf, stderr: stderrBuf, timedOut };
  } finally {
    clearTimeout(timer);
  }
}
