export type EventKind = "info" | "ok" | "warn" | "danger";

const LABELS: Record<string, { label: string; kind: EventKind }> = {
  open: { label: "Session opened", kind: "info" },
  "open-solo": { label: "claudeSolo opened", kind: "info" },
  recreate: { label: "Container recreated", kind: "info" },
  "agent-switch": { label: "Agent switched (container recreated)", kind: "info" },
  "agent-switch-live": { label: "Agent switched (live)", kind: "info" },
  stop: { label: "Session stopped", kind: "info" },
  end: { label: "Session ended", kind: "info" },
  "restart-solo": { label: "claudeSolo restarted", kind: "info" },
  clone: { label: "Repo cloned", kind: "info" },
  worktree: { label: "Worktree created", kind: "info" },
  "pull-conflict": { label: "Pull conflict", kind: "warn" },
  "pull-error": { label: "Pull error", kind: "warn" },
  agent_done: { label: "Claude finished the work", kind: "ok" },
  agent_blocked: { label: "Claude is waiting for input", kind: "warn" },
  agent_stuck: { label: "Claude may be stuck", kind: "danger" },
  schedule_run: { label: "Scheduled run started", kind: "info" },
  schedule_skip: { label: "Scheduled run skipped", kind: "info" },
  schedule_error: { label: "Scheduled run failed", kind: "danger" },
  auto_end: { label: "Scheduled run ended itself", kind: "info" },
  auto_end_kept: { label: "Worktree kept — uncommitted work", kind: "warn" },
  auto_end_error: { label: "Scheduled run failed to end", kind: "danger" },
  terminal_open: { label: "Terminal opened", kind: "info" },
  terminal_control: { label: "Terminal control taken", kind: "info" },
  // "waiting"/"idle" from the design do not exist in EventKind (only info/ok/warn/danger) — requested
  // mapped to "warn" like prod_write_proposed (waiting for a human decision),
  // grant_revoked to "info" like auto_end (neutral, something the operator asked for).
  ssh_key_requested: { label: "Agent requested an SSH key", kind: "warn" },
  ssh_key_approved: { label: "SSH key approved", kind: "ok" },
  ssh_key_denied: { label: "SSH key denied", kind: "danger" },
  ssh_key_access: { label: "SSH key handed to ssh-agent", kind: "ok" },
  ssh_key_bypass: { label: "SSH gate bypassed (break-glass)", kind: "danger" },
  ssh_grant_revoked: { label: "SSH grant revoked", kind: "info" },
  clipboard_access: { label: "Clipboard access", kind: "info" },
  critic_pass: { label: "Critic approved the work", kind: "ok" },
  critic_block: { label: "Critic sent the work back for fixes", kind: "warn" },
  critic_giveup: { label: "Critic couldn't agree — released with reservations", kind: "warn" },
  critic_error: { label: "Critic failed", kind: "danger" },
  critic_toggle: { label: "Critic toggled", kind: "info" },
  prod_db_access: { label: "Production DB read", kind: "info" },
  prod_write_proposed: { label: "Production write proposed", kind: "warn" },
  prod_write_executed: { label: "Production write executed", kind: "ok" },
  prod_write_rejected: { label: "Production write rejected", kind: "info" },
  cc_upgraded: { label: "Claude Code upgraded", kind: "ok" },
  cc_skipped: { label: "cc upgrade skipped", kind: "info" },
  cc_restart_failed: { label: "cc restart got stuck", kind: "warn" },
  cc_upgrade_failed: { label: "cc upgrade failed", kind: "danger" },
  host_update: { label: "System packages upgraded", kind: "info" },
  host_reboot: { label: "Machine rebooted from the dashboard", kind: "warn" },
};

export function eventLabel(type: string): { label: string; kind: EventKind } {
  return LABELS[type] ?? { label: type, kind: "info" };
}

export function eventDetail(data: string | null): string {
  if (!data) return "";
  let d: Record<string, unknown>;
  try { d = JSON.parse(data) as Record<string, unknown>; } catch { return ""; }
  const parts: string[] = [];
  for (const k of ["schedule", "branch", "kind", "files", "error", "container", "url", "message", "from", "to", "restarted", "stuck", "pane", "reason", "worktree"]) {
    const v = d[k];
    if (v === undefined || v === null) continue;
    parts.push(Array.isArray(v) ? v.join(", ") : String(v));
  }
  return parts.join(" · ");
}

export function sessionShort(sessionId: string | null): string {
  if (!sessionId) return "system";
  return sessionId.startsWith("dev-") ? sessionId.slice(4).replace("-", "/") : sessionId;
}
