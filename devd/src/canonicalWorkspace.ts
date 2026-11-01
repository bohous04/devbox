import { isAbsolute, normalize } from "node:path";
import { run, timeoutFor } from "./proc";

export interface CanonicalWorkspaceContainer {
  state: "running" | "stopped" | "missing";
  containerId?: string;
  workspace?: string;
  canonicalMount?: boolean;
}

export class CanonicalWorkspaceError extends Error {
  constructor(message: string, public kind: "unsafe" | "inspect" = "unsafe") { super(message); }
}

const directory = (value: unknown): value is string => typeof value === "string"
  && isAbsolute(value) && value !== "/" && normalize(value) === value && !/[\0\r\n]/.test(value);

/** Docker's persisted mount metadata, not a temporary nsenter mount. */
export function canonicalWorkspaceFromInspect(value: unknown): CanonicalWorkspaceContainer {
  const info = value as { id?: unknown; state?: unknown; running?: unknown; mounts?: unknown } | null;
  if (!info || typeof info.id !== "string" || !/^[0-9a-f]{64}$/.test(info.id) || !Array.isArray(info.mounts)) {
    throw new CanonicalWorkspaceError("Cannot verify container identity and workspace mounts");
  }
  if (!["running", "exited", "created"].includes(String(info.state))
      || info.running !== (info.state === "running")) {
    throw new CanonicalWorkspaceError("Container is busy restarting, paused, or being removed");
  }
  const mounts = info.mounts as { Type?: unknown; Source?: unknown; Destination?: unknown }[];
  const workspace = mounts.filter(m => m?.Destination === "/workspace");
  if (workspace.length !== 1 || workspace[0].Type !== "bind" || !directory(workspace[0].Source)) {
    throw new CanonicalWorkspaceError("Container has no unambiguous workspace bind");
  }
  const source = workspace[0].Source;
  const aliases = mounts.filter(m => m?.Destination === source);
  return {
    state: info.state === "running" ? "running" : "stopped",
    containerId: info.id,
    workspace: source,
    canonicalMount: aliases.length === 1 && aliases[0].Type === "bind" && aliases[0].Source === source,
  };
}

export async function inspectCanonicalWorkspace(name: string, execute: typeof run = run): Promise<CanonicalWorkspaceContainer> {
  const result = await execute(["docker", "inspect", "--type", "container", "--format",
    '{"id":{{json .Id}},"state":{{json .State.Status}},"running":{{json .State.Running}},"mounts":{{json .Mounts}}}', name],
  { timeoutMs: timeoutFor("DOCKER_QUERY") });
  if (result.timedOut) throw new CanonicalWorkspaceError("Docker workspace inspection timed out", "inspect");
  if (result.code !== 0) {
    if (/No such (object|container)/i.test(result.stderr)) return { state: "missing" };
    throw new CanonicalWorkspaceError("Cannot inspect the exact container workspace", "inspect");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(result.stdout); }
  catch { throw new CanonicalWorkspaceError("Docker returned invalid workspace inspection data", "inspect"); }
  return canonicalWorkspaceFromInspect(parsed);
}

/** No force: Docker itself refuses removal if another client starts this ID. */
export async function removeStoppedWorkspaceContainer(observed: CanonicalWorkspaceContainer, execute: typeof run = run): Promise<void> {
  if (observed.state !== "stopped" || !observed.containerId || !/^[0-9a-f]{64}$/.test(observed.containerId)) {
    throw new CanonicalWorkspaceError("Canonical workspace migration requires a verified stopped container");
  }
  const result = await execute(["docker", "rm", observed.containerId], { timeoutMs: timeoutFor("DOCKER_LIFECYCLE") });
  if (result.timedOut || result.code !== 0) {
    throw new CanonicalWorkspaceError("Cannot replace stopped container; it may have started concurrently. Retry after stopping it.", "inspect");
  }
}
