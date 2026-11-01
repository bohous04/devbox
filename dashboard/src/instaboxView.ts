// Mirrors devd/src/instabox/reconcile.ts IbxStatus and instabox/sessions.ts IbxJob
// (the dashboard must not import devd sources, see newSession.ts).
export type IbxStatusDto =
  | { enabled: false }
  | { enabled: true; ok: boolean; error?: string; machines: number; devboxMachines: number; maxMachines: number; storedBytes: number; maxStoredBytes: number;
      base: { snapshotId: string; builtAt: number; stale: boolean } | null; orphans: { id: string; name: string; state: string }[];
      buildLeftovers?: { id: string; name: string; state: string }[]; lost: string[] };
export interface IbxJobDto { id: string; sessionId?: string; status: "running" | "done" | "error"; step: string; error?: string; startedAt: number }
export interface PlacementDto { suggest: "vps" | "instabox"; reason: string | null }

export const JOB_STEP_LABEL: Record<string, string> = {
  preflight: "Checking capacity", machine: "Starting machine", ssh: "Connecting SSH", tailscale: "Joining tailnet",
  dirs: "Preparing disk", volumes: "Copying logins and settings", secrets: "Passing git access", clone: "Cloning repo",
  container: "Starting container", desktop: "Starting desktop", done: "Done",
  // kroky base buildu (Task 11)
  digest: "Reading image digest", tools: "Installing tools", image: "Uploading devbox image", snapshot: "Saving snapshot", cleanup: "Cleaning up",
};

// R3: several sessions per repo are normal, so "repo already has a session" does not block InstaBox.
// `agentBlock`: reason from instaboxAgentBlock (newSession.ts, mirrors devd/src/agents.ts) —
// proxy profiles (claude-gpt, claude-grok, claude-gemini, claude-openrouter) and Antigravity
// run only on the VPS; the server rejects them on InstaBox with 400 (check order same as
// POST /api/sessions: solo before agent).
export function hostDisabledReason(s: IbxStatusDto, isSolo: boolean, agentBlock: string | null = null): string | null {
  if (!s.enabled) return "InstaBox is not configured";
  if (!s.ok) return "InstaBox API is unavailable";
  if (isSolo) return "claudeSolo runs only on the VPS";
  if (agentBlock) return agentBlock;
  if (!s.base) return "Build the InstaBox base first";
  if (s.machines >= s.maxMachines) return `InstaBox ${s.machines}/${s.maxMachines} — stop or delete a machine`;
  return null;
}

export function capacityLabel(s: Extract<IbxStatusDto, { enabled: true }>): string { return `InstaBox ${s.machines}/${s.maxMachines}`; }

export function jobErrorText(step: string, error?: string): string { return `${JOB_STEP_LABEL[step] ?? step}: ${error ?? "failed"}`; }

// The stream link has a TTL of 600 s; a new one is requested a minute ahead (spec §4). Expiry stops only
// NEW connections, an open iframe keeps running — so the renewed link is only stored for
// reconnecting; the iframe is not reloaded because of it (M7).
export function refreshDelayMs(expiresAt: number, now: number): number { return Math.max(5_000, expiresAt - now - 60_000); }

// Reconnect: the link renewed in advance, if it is still valid for at least a while; otherwise null →
// the modal requests a new one (without invalidation, refresh). 5 s margin for loading the iframe.
export function reconnectLink<L extends { expiresAt: number }>(fresh: L | null, now: number): L | null {
  return fresh && fresh.expiresAt - now > 5_000 ? fresh : null;
}

// Close/unmount with active control would otherwise leave an unauthenticated control
// link dangling (anyone who knows the URL could control the agent's desktop) — it must be invalidated
// even without clicking Give back. A view-only link does no harm, so it is not invalidated.
export function shouldRevokeOnClose(control: boolean): boolean { return control; }
