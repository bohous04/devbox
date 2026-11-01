import { observedMountDestinations } from "./accountMountRepair";
import { run, timeoutFor, type RunResult, type TimeoutGroup } from "./proc";
import { dockerArgv, runDocker } from "./dockerTarget";

export interface RunOpts {
  name: string; image: string; workspace: string; portBase: number; portsPerSession: number;
  bindIp?: string; extraMounts?: string[]; env?: Record<string, string>; cmd?: string[];
  /** Sidecar (dind) network. Without it the container stays on the default bridge. */
  network?: string;
}

// A timeout is an ERROR, never a state: the caller must not confuse "docker did not respond" with
// "the container does not exist" — the latter means recreate. Audit of containerState callers
// (spec §3.6, three places): sessions.ts open() — the exception propagates → API 400, no
// runContainer; sessions.ts restartSolo() — the exception propagates → API 404, the container
// is not touched; index.ts scheduler.containerRunning — exception → scheduler.tick(...)
// .catch(console.error), the scheduled run skips that tick. Nowhere is the exception
// mapped to "missing".
async function docker(group: TimeoutGroup, target: string, ...args: string[]): Promise<RunResult> {
  const ms = timeoutFor(group);
  const r = await runDocker(target, args, { timeoutMs: ms });
  if (r.timedOut) throw new Error(`docker ${args[0]} timed out after ${Math.round(ms / 1000)} s`);
  return r;
}

/** RAM cap for the session container (and separately for its dind sidecar). Without it a single
 *  runaway `next dev` took over 12 GB, the server ran out of memory (OOM) and even sshd/tailscale froze
 *  (2 Oct 2026). With the cap, the OOM killer kills a process only inside that session.
 *  Plus 20 GB of swap (`--memory-swap` = RAM + swap): Codex starts a separate MCP set (~1 GB)
 *  for every subagent, so at 12 GB without swap it was killed 17× in 10 days (5–15 Oct).
 *  With swap the session slows down at peak instead of crashing. */
export const SESSION_MEMORY_LIMIT = "15g";
export const SESSION_MEMORY_SWAP_LIMIT = "35g";
export const memoryArgs = () => ["--memory", SESSION_MEMORY_LIMIT, "--memory-swap", SESSION_MEMORY_SWAP_LIMIT];

/** Building arguments separately from running, so it can be tested without docker. */
export function runArgs(o: RunOpts): string[] {
  const args = ["run", "-d", "--init", "--name", o.name, "--restart", "unless-stopped",
    ...memoryArgs(),
    "--add-host=host.docker.internal:host-gateway",
    // No core dumps: core_pattern is plain `core`, so every crash (vitest workers,
    // chrome, claude) wrote a ~5 GB file into the workspace — 390 GB by 2026-10-13.
    "--ulimit", "core=0",
    "-v", `${o.workspace}:/workspace`, "-w", "/workspace"];
  // Remote Codex needs the canonical project path before its TUI bootstraps.
  // A Docker-managed alias also survives stop/start without dispatcher repair.
  const canonicalMount = `${o.workspace}:${o.workspace}`;
  const hasCanonicalMount = (o.extraMounts ?? []).some(m => m === canonicalMount || m.startsWith(`${canonicalMount}:`));
  if (o.workspace !== "/workspace" && !hasCanonicalMount) args.push("-v", canonicalMount);
  if (o.network) args.push("--network", o.network);
  for (let i = 0; i < o.portsPerSession; i++) {
    const host = `${o.bindIp ?? "127.0.0.1"}:${o.portBase + i}`;
    args.push("-p", `${host}:${3000 + i}`);
  }
  for (const m of o.extraMounts ?? []) args.push("-v", m);
  for (const [k, v] of Object.entries(o.env ?? {})) args.push("-e", `${k}=${v}`);
  args.push(o.image, ...(o.cmd ?? []));
  return args;
}

export async function runContainer(o: RunOpts): Promise<void> {
  const r = await docker("DOCKER_LIFECYCLE", o.name, ...runArgs(o));
  if (r.code !== 0) throw new Error(`docker run failed: ${r.stderr.trim()}`);
}

export async function startContainer(name: string): Promise<void> {
  const r = await docker("DOCKER_LIFECYCLE", name, "start", name);
  if (r.code !== 0) throw new Error(`docker start failed: ${r.stderr.trim()}`);
}

export async function stopContainer(name: string): Promise<void> {
  const r = await docker("DOCKER_LIFECYCLE", name, "stop", name);
  if (r.code !== 0) throw new Error(`docker stop failed: ${r.stderr.trim()}`);
}

export async function removeContainer(name: string): Promise<void> {
  const r = await docker("DOCKER_LIFECYCLE", name, "rm", "-f", name);
  // tolerant: missing container is fine; any other failure must surface
  if (r.code !== 0 && !r.stderr.includes("No such container")) {
    throw new Error(`docker rm failed: ${r.stderr.trim()}`);
  }
}

export async function containerState(name: string): Promise<"running" | "exited" | "missing"> {
  const r = await docker("DOCKER_QUERY", name, "inspect", "-f", "{{.State.Status}}", name);
  if (r.code !== 0) return "missing";
  return r.stdout.trim() === "running" ? "running" : "exited";
}

/** The environment the container was CREATED with (`docker run -e`). `docker start`
 *  does not change the environment, so this is exactly what will run in it after a restart — and
 *  the only way to find out that a baked-in value no longer matches reality.
 *  One `docker inspect` for the whole array, not one per variable: the call is now
 *  asynchronous via `proc.run` and does not block the event loop, but a single inspect
 *  remains — every extra process still costs time.
 *  null = the container does not exist or the output could not be read. */
export async function containerEnv(name: string): Promise<Record<string, string> | null> {
  const r = await docker("DOCKER_QUERY", name, "inspect", "-f", "{{json .Config.Env}}", name);
  if (r.code !== 0) return null;
  let list: unknown;
  try { list = JSON.parse(r.stdout.trim()); } catch { return null; }
  if (!Array.isArray(list)) return null;
  const out: Record<string, string> = {};
  for (const e of list) {
    if (typeof e !== "string") continue;
    const i = e.indexOf("=");           // the value may contain "=", the name may not
    if (i > 0) out[e.slice(0, i)] = e.slice(i + 1);
  }
  return out;
}

/** Destination paths currently mounted in the container. null = inspect failed. */
export async function containerMountDestinations(name: string): Promise<string[] | null> {
  const r = await docker("DOCKER_QUERY", name, "inspect", "-f", "{{json .Mounts}}", name);
  if (r.code !== 0) return null;
  try { return observedMountDestinations(JSON.parse(r.stdout.trim())); } catch { return null; }
}

// Watchdog probe and similar short calls. Timeout is NOT thrown here — the caller reads
// `timedOut`/`code` (the watchdog treats undetermined as "inactive", as it does exit≠0 today).
export async function execInContainer(name: string, cmd: string[]): Promise<RunResult> {
  return runDocker(name, ["exec", name, ...cmd], { timeoutMs: timeoutFor("DOCKER_QUERY") });
}

/** Backward-compatible name for index.ts and ccUpkeep — just a thin wrapper over proc.run. */
export function spawnWithTimeout(cmd: string[], timeoutMs: number, input?: string): Promise<RunResult> {
  return run(cmd, { timeoutMs, stdin: input });
}

// -i (interactive stdin) is needed only when we call with input — otherwise docker
// exec would needlessly keep stdin open towards the container.
//
// -e DEVD_SESSION_ID= : the critic's own `claude -p` runs INSIDE the container of the
// same session, so it would otherwise inherit DEVD_SESSION_ID and trigger the devd lifecycle
// hooks (/opt/devd-hooks/devd-hook.sh) — including the synchronous Stop hook, which
// calls devd `/api/agent-event`, which for a session with the critic enabled starts ANOTHER
// critic → its `claude -p` again triggers the Stop hook → infinite recursion (verified
// live: `claude -p` in docker exec hung for over 150 s and processes piled up).
// An empty DEVD_SESSION_ID makes devd-hook.sh a no-op thanks to its own
// guard condition `[ -n "${DEVD_SESSION_ID:-}" ] && [ -n "${DEVD_URL:-}" ] || exit 0`.
// The critic's authentication is unaffected — it comes from the claude-home credentials, not from
// DEVD_SESSION_ID.
function criticExecArgs(name: string, cmd: string[], hasInput: boolean): string[] {
  return hasInput
    ? ["exec", "-i", "-e", "DEVD_SESSION_ID=", name, ...cmd]
    : ["exec", "-e", "DEVD_SESSION_ID=", name, ...cmd];
}

/**
 * Builds the argv for `docker exec` called by the critic (see execInContainerAsync below).
 * Pure function for testability — no process is spawned.
 */
export function criticExecArgv(name: string, cmd: string[], hasInput: boolean): string[] {
  return [...dockerArgv(name), ...criticExecArgs(name, cmd, hasInput)];
}

export async function execInContainerAsync(name: string, cmd: string[], timeoutMs: number, input?: string) {
  return runDocker(name, criticExecArgs(name, cmd, input !== undefined), { timeoutMs, stdin: input });
}
