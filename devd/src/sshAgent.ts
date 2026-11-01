import { rmSync } from "node:fs";
import { join } from "node:path";
// Renamed to `procRun` (not `run`): `createSshAgents` below has its own local
// `run = deps.run ?? defaultRun` and the same name would be shadowed — safe as long as
// no call that mistakenly wanted this one is added inside `createSshAgents` (review finding).
import { run as procRun, timeoutFor } from "./proc";

/** The path at which the container sees the socket: controlDir(<session>) is mounted in sessions.ts
 *  at /run/devd, so the file name is enough. */
export const CONTAINER_SOCK = "/run/devd/ssh-agent.sock";
const SOCK_FILE = "ssh-agent.sock";
/** The user in the container (see chmod 0777 on controlDir in sessions.ts). Exported
 *  for tests that verify the shape of the command wrapped via setpriv (see below). */
export const CONTAINER_UID = 1000;

type RunResult = { code: number; stdout: string; stderr: string };
export type RunFn = (cmd: string[], stdin?: string, env?: Record<string, string>) => RunResult | Promise<RunResult>;

export interface SshAgentDeps {
  controlDir: (session: string) => string;
  readKey: (title: string) => string | Promise<string>;
  run?: RunFn;
  rm?: (path: string) => void;
  /** Uid this devd process is currently running as. Default `process.getuid`;
   *  tests inject it, because the real behavior (root dropping privileges to the
   *  container uid) could otherwise only be tested as actual root — see resolveWrap. */
  getuid?: () => number | undefined;
}

export interface SshAgents {
  activate(session: string, title: string): Promise<{ agentSock: string }>;
  /** Without `title`: kill whatever is running in this session (used internally by `activate` when
   *  swapping the key — a session always has at most one agent, see below).
   *  With `title`: kill ONLY if the running agent serves exactly this key — otherwise a
   *  no-op. Callers that only know the title of an expired/revoked grant (reaper,
   *  DELETE /api/ssh-grants) must use this form — otherwise they could tear down
   *  an agent the session has meanwhile switched to an entirely different key (see below). */
  kill(session: string, title?: string): Promise<void>;
  sockPathFor(session: string): string;
}

// Exported only for the test that verifies the env really reaches the child
// (see sshAgent.test.ts) — with the fake `run` in the other tests defaultRun
// never runs. A thin wrapper over `run()` (proc.ts): a missing binary (typically
// `setpriv` below, when we drop privileges to the container uid) is converted there to
// { code: 127, stderr } without an exception, so the caller here needs no try/catch
// around spawning the process.
export const defaultRun: RunFn = (cmd, stdin, env) => procRun(cmd, { stdin, env, timeoutMs: timeoutFor("SSH_AGENT") });

/** Wraps a command so that `setpriv` runs it under the container uid. `setpriv`
 *  (util-linux, present on the host by default) instead of `runuser`: `runuser -u`
 *  starts the given user's login shell through PAM, which for a single exec is a needless
 *  extra layer (and more shell escaping); `setpriv` just switches
 *  uid/gid with a syscall and directly exec()s the given command. `--clear-groups` drops root's
 *  supplementary groups, so the socket does not end up with an unexpected extra gid. */
function withContainerUid(cmd: string[]): string[] {
  return ["setpriv", `--reuid=${CONTAINER_UID}`, `--regid=${CONTAINER_UID}`, "--clear-groups", ...cmd];
}

/** OpenSSH `ssh-agent` rejects a client whose uid does not match the uid the agent
 *  itself runs as (a peer-uid check directly on the unix socket) — a `chown` of the socket itself
 *  has no effect on this. That is exactly what showed up during manual verification on the
 *  host: devd runs as root, the container as uid 1000, and `ssh-agent`/`ssh-add`
 *  therefore have to run UNDER the container uid, not as root with a subsequently chowned
 *  socket.
 *
 *  Decision on when to drop privileges:
 *  - devd already runs under the container uid → run directly; wrapping would be
 *    pointless (and might not even be allowed — `setpriv --reuid` to one's own uid).
 *  - devd runs as root → drop via `setpriv` (see withContainerUid).
 *  - anything else (devd runs under some third uid) → cannot be satisfied safely,
 *    because `setpriv` without root cannot switch to a foreign uid. Fail IMMEDIATELY and
 *    loudly with the cause in the message, rather than trying to run the agent as that foreign uid and
 *    letting it silently fall back to root — that would reproduce exactly the bug this
 *    fix addresses, just one step further and harder to trace (the error would only show up
 *    in the container as "communication with agent failed"). */
function resolveWrap(myUid: number | undefined): (cmd: string[]) => string[] {
  if (myUid === CONTAINER_UID) return (cmd) => cmd;
  if (myUid === 0) return withContainerUid;
  throw new Error(
    `ssh-agent cannot be started safely: devd runs as uid ${myUid ?? "unknown"}, ` +
      `not as root and not as the container uid (${CONTAINER_UID}) — it has no permission to ` +
      `switch to it (setpriv cannot switch to another uid without root). Run devd as root, ` +
      `or directly as uid ${CONTAINER_UID}.`,
  );
}

/** Serializes jobs submitted under the same key (see `chains` in createSshAgents
 *  below — the reaper/DELETE must not hit the agent in the middle of activation). Independent keys
 *  do not wait for each other. The `chains` entry is deleted once the LAST job queued on
 *  that key has settled — without that a long-running devd would accumulate one settled
 *  promise per key forever, even for long-gone sessions (review finding). The identity
 *  check (`chains.get(key) === tail`) is necessary: another job queued meanwhile
 *  on the same key moved `chains.get(key)` to a NEW tail, and that one we must not delete —
 *  otherwise the anti-poisoning `.catch` wrapper for the queue that has yet to run
 *  would be lost too. */
export function createSerial(): { run<T>(key: string, fn: () => Promise<T>): Promise<T>; size(): number } {
  const chains = new Map<string, Promise<unknown>>();
  const run = <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const prev = chains.get(key) ?? Promise.resolve();
    const job = prev.then(fn, fn);
    // A caught error must not propagate into the CHAIN (only into the `job` the
    // caller gets) — otherwise the first failure would permanently poison `chains` and every further
    // operation on the same key would forever get a rejected promise without a listener.
    const tail = job.catch(() => {});
    chains.set(key, tail);
    tail.then(() => { if (chains.get(key) === tail) chains.delete(key); });
    return job;
  };
  return { run, size: () => chains.size };
}

export function createSshAgents(deps: SshAgentDeps): SshAgents {
  const run = deps.run ?? defaultRun;
  const rm = deps.rm ?? ((p) => rmSync(p, { force: true }));
  const getuid = deps.getuid ?? (() => process.getuid?.());
  /** session → PID, title and public identity of the successfully loaded agent. Kept in memory; a devd restart
   *  orphans the agents, which is why the socket is always deleted before starting (ssh-agent will not bind to an
   *  occupied one). Keyed ONLY by session (not (session, title)) — `activate`
   *  keeps at most one agent per session, the `title` in the map value only says
   *  WHICH key this single agent currently serves, so that `kill(session, title)`
   *  below can verify it before acting (review finding: the reaper/DELETE used to kill
   *  by the bare session and thereby also tore down the agent of another, currently active key). */
  const pids = new Map<string, { pid: number; title: string; identity?: string }>();

  const sockPathFor = (session: string) => join(deps.controlDir(session), SOCK_FILE);

  // Operations on one session in sequence: the reaper/DELETE must not hit the agent in the middle
  // of activation (ssh-agent already running, ssh-add not yet) — without this a concurrent kill
  // could tear down the socket exactly while activate() is still adding the
  // key to it, and activate() would then end with a confusing error about a dead agent instead of
  // the understandable "ssh-add failed". The chain is PER SESSION (not a global lock) —
  // concurrent operations on two different sessions do not wait for each other. The mechanism is
  // in createSerial() above (it prunes settled entries itself).
  const { run: serial } = createSerial();

  async function killNow(session: string, title?: string): Promise<void> {
    const entry = pids.get(session);
    // The running agent belongs to a different key than the one that asked for the kill — leave it alone.
    // Without this condition an expired/revoked grant for key A would tear down the agent that the
    // session has meanwhile activated for key B (see the comment at SshAgents.kill above).
    if (entry && title !== undefined && entry.title !== title) return;
    // `kill <pid>` is not wrapped with setpriv: devd sends it either as root (which may
    // signal a process of any uid) or under the container uid (the same as the
    // agent it started itself) — in both cases it goes through directly.
    if (entry) { await run(["kill", String(entry.pid)]); pids.delete(session); }
    rm(sockPathFor(session));
  }

  // The live socket's answer, under the same uid as ssh-add when loading. Exactly
  // one public identity; the comment is not part of the key. We do not read 1Password nor
  // take over agents after a restart for which we have no verified identity in memory.
  async function identityAt(sock: string, wrap: (cmd: string[]) => string[]): Promise<string | null> {
    const result = await run(wrap(["ssh-add", "-L"]), undefined, { SSH_AUTH_SOCK: sock });
    if (result.code !== 0) return null;
    const lines = result.stdout.trim().split("\n");
    if (lines.length !== 1) return null;
    const [type, blob] = lines[0]!.trim().split(/\s+/);
    if (!type || !/^(ssh-|ecdsa-|sk-)[A-Za-z0-9@._-]+$/.test(type) || !blob || !/^[A-Za-z0-9+/]+={0,2}$/.test(blob)) return null;
    return `${type} ${blob}`;
  }

  return {
    sockPathFor,
    kill: (session, title) => serial(session, () => killNow(session, title)),
    activate: (session, title) => serial(session, async () => {
      const sock = sockPathFor(session);
      // Must throw BEFORE we start anything — fail closed, not a silent fallback
      // to root (see resolveWrap above).
      const wrap = resolveWrap(getuid());
      const current = pids.get(session);
      if (current?.title === title && current.identity) {
        const identity = await identityAt(sock, wrap).catch(() => null);
        if (identity === current.identity) return { agentSock: CONTAINER_SOCK };
      }

      // A 1Password outage must not destroy a so-far working agent. We load the key
      // before replacing the socket; the same-title reuse above does no new read.
      // The grant authorization check and its revocation stay at the API boundary.
      const key = await deps.readKey(title);
      await killNow(session); // one session = one agent with one key
      try {
        const started = await run(wrap(["ssh-agent", "-a", sock]));
        if (started.code !== 0) throw new Error(`ssh-agent failed: ${started.stderr.trim() || "unknown error"}`);
        const pid = Number(started.stdout.match(/SSH_AGENT_PID=(\d+)/)?.[1] ?? 0);
        if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("ssh-agent did not return a valid PID");
        pids.set(session, { pid, title });

        // The key goes to STDIN, never into argv — argv is visible in `ps`.
        // The trailing newline is mandatory, otherwise ssh-add rejects it.
        // ssh-add finds the agent via SSH_AUTH_SOCK from the environment (it has no argument for it) —
        // which is why we pass it as the third argument of `run()`, not by mutating process.env: that
        // would be shared with all concurrent operations in the process and a race could
        // slip a foreign SSH_AUTH_SOCK to another command running at that moment. ssh-add must
        // run under the same uid as the agent (the same `wrap`) — otherwise the agent rejects it for the
        // same peer-uid reason (see resolveWrap).
        const added = await run(wrap(["ssh-add", "-"]), key.endsWith("\n") ? key : key + "\n", { SSH_AUTH_SOCK: sock });
        if (added.code !== 0) throw new Error(`ssh-add failed: ${added.stderr.trim() || "unknown error"}`);
        const identity = await identityAt(sock, wrap);
        if (!identity) throw new Error("ssh-agent did not return exactly one loaded public identity");
        pids.set(session, { pid, title, identity });
      } catch (error) {
        await killNow(session);
        throw error;
      }
      // The socket is created directly under the container uid — either devd itself runs that way, or
      // setpriv above dropped it there — so an additional chown is pointless (and it used to give
      // the impression that it handles access on its own, even though the peer-uid check checks the uid
      // of the agent process, not the owner of the file).
      return { agentSock: CONTAINER_SOCK };
    }),
  };
}
