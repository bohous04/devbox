import type { AgentName, SessionRow } from "../../devd/src/db";
import type { PaneAgentResult } from "../../devd/src/agentSwitch";
import type { PullResult } from "../../devd/src/git";
import type { OpenProgress } from "../../devd/src/sessions";
import type { TreeProject } from "../../devd/src/tree";
import type { WriteRow } from "../../devd/src/prodWrites";
import type { ClaudeState } from "../../devd/src/stats";
import type { TmuxSession } from "../../devd/src/tmux";
import type { CodexSessionAccountView, CodexSessionAccountSwitchResult } from "../../devd/src/codexSessionAccounts";
import { rememberDockerHosts } from "./attach";
import type { IbxJob } from "../../devd/src/instabox/sessions";
import type { IbxStatus } from "../../devd/src/instabox/reconcile";
import type { BaseStep } from "../../devd/src/instabox/base";

export type { WriteRow, CodexSessionAccountView, CodexSessionAccountSwitchResult, OpenProgress };

// claudeState: live agent state from metrics (working/waiting/idle, see devd stats.ts).
// Optional — an older devd may not return it in /api/sessions.
// tmux: list of Claude sessions in the container — only when asked for (`?tmux=1`);
// an older devd does not return it at all.
export interface SessionInfo extends SessionRow {
  ports: { host: number; container: number }[];
  claudeState?: ClaudeState;
  tmux?: TmuxSession[];
  dockerHost?: string | null;
}
export interface OpenResult { session: SessionRow; pull?: PullResult; created: boolean; claudePrompt?: string }

// Response of POST /api/sessions/:id/switch-account (see devd/src/accountSwitch.ts).
// `panes`: one row for EVERY pane with a live claude in the container (main and
// main-2/main-3 share the sessionId) — "restarted" and "already-on-account" are BOTH
// success (the latter means the pane was already on the target profile BEFORE the
// call, so it was not touched at all); "did-not-exit"/"did-not-return"/"stuck-on-dialog"/
// "unknown-session" mean that this particular pane stayed (or ended up)
/** Row from GET /api/local-env — ready-made env for running a proxy profile locally
 *  (dev local). Mirrors devd/src/localEnv.ts. */
export interface LocalEnvProfile {
  profile: string;
  label: string;
  ready: boolean;
  reason?: string;
  env?: Record<string, string>;
  unset?: string[];
}

// Response of POST /api/sessions/:id/agent (see devd/src/agentSwitch.ts). On the wire
// it carries `status` (the error states unknown/not-running/in-progress arrive as HTTP errors);
// pane shapes are taken straight from devd so the outcome enum is not copied a third time.
export interface SwitchAgentResponse {
  ok: boolean;
  status: "unchanged" | "no-agent" | "switched" | "failed";
  panes: PaneAgentResult[];
}

// outside the new profile and the operator should look at it themselves.
export interface SwitchAccountResponse {
  ok: boolean;
  accountId: string | null;
  label: string | null;
  unchanged: boolean;   // target account == the one the session was already on — nothing was restarted
  exhausted: boolean;   // the target account is over the threshold anyway (all-exhausted policy branch)
  panes: { target: string; outcome: "restarted" | "already-on-account" | "did-not-exit" | "did-not-return" | "stuck-on-dialog" | "unknown-session" }[];
}

export class ApiClient {
  constructor(private baseUrl: string) {}

  private async req<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: body !== undefined ? { "content-type": "application/json" } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal,
      });
    } catch {
      throw new Error(`devd is unreachable at ${this.baseUrl} — try \`dev doctor\``);
    }
    if (res.status === 204) return undefined as T;
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(err.error ?? `devd returned ${res.status}`);
    }
    return (await res.json()) as T;
  }

  health() { return this.req<{ ok: boolean; version: string }>("GET", "/api/health"); }

  /** Proxy profiles for `dev local`. Own fetch with a short timeout and a silent
   *  fallback to []: off the tailnet the picker must neither wait nor crash — it just
   *  narrows down to local binaries. An older devd without the route ends up the same. */
  async localEnvProfiles(): Promise<LocalEnvProfile[]> {
    try {
      const res = await fetch(`${this.baseUrl}/api/local-env`, { signal: AbortSignal.timeout(1500) });
      if (!res.ok) return [];
      return ((await res.json()) as { profiles: LocalEnvProfile[] }).profiles;
    } catch { return []; }
  }
  tree() { return this.req<TreeProject[]>("GET", "/api/tree"); }
  async sessions(opts?: { tmux?: boolean; timeoutMs?: number }) {
    const rows = await this.req<SessionInfo[]>("GET", `/api/sessions${opts?.tmux ? "?tmux=1" : ""}`, undefined,
      opts?.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined);
    rememberDockerHosts(rows);   // attach to an InstaBox session needs `docker -H ssh://…`
    return rows;
  }
  // `fresh` = the user explicitly wanted ANOTHER session on this repo, not to join the
  // existing one. It always gets its own container, id and ports; its own worktree and branch
  // only for a repo in the new layout (see freshLabel — in the old one it shares files and branch with the first).
  // Without `fresh` devd joins the EXISTING session of that repo — a running one takes precedence
  // over a stopped one, on a tie the lowest ordinal wins (existingSessionId in sessions.ts) —
  // and creates a new one only when there is none. Not "the one with the base id": that was a silent bug
  // which, after the first session ended, quietly produced an extra container.
  open(t: { folder: string; project: string; repo?: string; cloneUrl?: string; solo?: boolean; agent?: AgentName; fresh?: boolean }) {
    return this.req<OpenResult>("POST", "/api/sessions", t);
  }
  // Progress of a running open() of the same repo; an older devd lacks the endpoint → null, the spinner stays bare.
  async openProgress(t: { folder: string; project: string; repo: string }): Promise<OpenProgress | null> {
    const q = new URLSearchParams({ folder: t.folder, project: t.project, repo: t.repo });
    try { return (await this.req<{ progress: OpenProgress | null }>("GET", `/api/open-progress?${q}`)).progress ?? null; }
    catch { return null; }
  }
  // InstaBox always creates a NEW session (a job with progress); unlike open() it does not join.
  openInstabox(t: { folder: string; project: string; repo: string; cloneUrl: string; agent?: AgentName }) {
    return this.req<{ jobId: string; sessionId: string }>("POST", "/api/sessions", { ...t, host: "instabox" });
  }
  instaboxJob(id: string) { return this.req<IbxJob>("GET", `/api/instabox/jobs/${encodeURIComponent(id)}`); }
  instaboxStatus() { return this.req<IbxStatus | { enabled: false }>("GET", "/api/instabox/status"); }
  // Short timeout: placement is only a hint for `openAndAttach` and a slow/stuck devd
  // must not delay it — the caller swallows the error anyway (.catch(() => null)).
  placement() { return this.req<{ suggest: "vps" | "instabox"; reason: string | null }>("GET", "/api/placement", undefined, AbortSignal.timeout(2000)); }
  rebuildBase() { return this.req<{ jobId: string }>("POST", "/api/instabox/base/rebuild"); }
  baseJob(id: string) { return this.req<{ id: string; status: "running" | "done" | "error"; step: BaseStep; error?: string }>("GET", `/api/instabox/base/jobs/${encodeURIComponent(id)}`); }

  stop(id: string) { return this.req<void>("POST", `/api/sessions/${id}/stop`); }
  restart(id: string) { return this.req<void>("POST", `/api/sessions/${id}/restart`); }
  // `dev switch`: devd itself picks the target account, restarts EVERY pane with a live
  // claude in the container (main and main-2/main-3 share the sessionId, see
  // accountSwitch.ts) and writes the lease only once at least one pane has verifiably
  // restarted. The token never appears in the response.
  switchAccount(sessionId: string) {
    return this.req<SwitchAccountResponse>("POST", `/api/sessions/${sessionId}/switch-account`);
  }
  codexAccount(sessionId: string) {
    return this.req<CodexSessionAccountView>("GET", `/api/sessions/${encodeURIComponent(sessionId)}/codex-account`);
  }
  switchCodexAccount(sessionId: string, accountId: string) {
    return this.req<CodexSessionAccountSwitchResult>("POST", `/api/sessions/${encodeURIComponent(sessionId)}/codex-account`, { accountId });
  }
  // Live agent (harness) swap of a running session — devd restarts every pane
  // with a live agent onto the new profile (claude→claude* with best-effort --resume), see
  // devd/src/agentSwitch.ts. The DB changes only once at least one pane succeeds.
  switchAgent(sessionId: string, agent: AgentName) {
    return this.req<SwitchAgentResponse>("POST", `/api/sessions/${sessionId}/agent`, { agent });
  }
  important(id: string, important: boolean) { return this.req<void>("POST", `/api/sessions/${id}/important`, { important }); }
  setName(id: string, name: string) { return this.req<void>("POST", `/api/sessions/${id}/name`, { name }); }
  /** `pending` = devd is still backing up (storage guard) and End finishes in the background. */
  end(id: string, soloAction?: "keep" | "delete") {
    return this.req<{ pending?: boolean } | undefined>("POST", `/api/sessions/${id}/end`, soloAction ? { soloAction } : {});
  }
  clone(scope: { scope: "all" } | { scope: "folder"; folder: string } | { scope: "project"; folder: string; project: string }) {
    return this.req<{ jobId: string }>("POST", "/api/clone", scope);
  }
  job(id: string) { return this.req<import("../../devd/src/clone").CloneJob>("GET", `/api/jobs/${id}`); }
  prodWrites(status?: string) { return this.req<WriteRow[]>("GET", `/api/prod-db/writes${status ? `?status=${status}` : ""}`); }
  prodWrite(id: number) { return this.req<WriteRow>("GET", `/api/prod-db/writes/${id}`); }
  prodWritePreview(id: number) { return this.req<{ rows: number; note: string }>("GET", `/api/prod-db/writes/${id}/preview`); }
  prodWriteApprove(id: number) { return this.req<{ rows: number; note: string }>("POST", `/api/prod-db/writes/${id}/approve`); }
  prodWriteReject(id: number) { return this.req<{ ok: boolean }>("POST", `/api/prod-db/writes/${id}/reject`); }

  async backup(): Promise<Uint8Array> {
    const r = await fetch(`${this.baseUrl}/api/backup`);
    if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `devd ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
  }
  async restore(bytes: Uint8Array): Promise<void> {
    const r = await fetch(`${this.baseUrl}/api/restore`, { method: "POST", body: bytes });
    if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `devd ${r.status}`);
  }
}
