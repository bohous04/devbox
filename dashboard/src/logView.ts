/** Event groups for the filter in Log. The user does not want to tick thirty types —
 *  they want "show me only the critic" or "only production writes". */
export interface LogGroup { id: string; label: string; types: string[] }

export const LOG_GROUPS: LogGroup[] = [
  { id: "session", label: "Sessions", types: ["open", "open-solo", "recreate", "stop", "end", "restart-solo", "clone", "pull-conflict", "pull-error"] },
  { id: "agent", label: "Agent", types: ["agent_done", "agent_blocked", "agent_stuck"] },
  { id: "critic", label: "Critic", types: ["critic_pass", "critic_block", "critic_giveup", "critic_error", "critic_toggle"] },
  { id: "cc", label: "cc upkeep", types: ["cc_upgraded", "cc_skipped", "cc_restart_failed", "cc_upgrade_failed"] },
  { id: "schedule", label: "Scheduled runs", types: ["schedule_run", "schedule_skip", "schedule_error", "auto_end", "auto_end_kept", "auto_end_error"] },
  { id: "prod", label: "Production DB", types: ["prod_db_access", "prod_write_proposed", "prod_write_executed", "prod_write_rejected"] },
  { id: "host", label: "Host maintenance", types: ["host_update", "host_reboot"] },
  { id: "access", label: "Access", types: ["terminal_open", "terminal_control", "ssh_key_access", "clipboard_access"] },
];

const GROUPED = new Set(LOG_GROUPS.flatMap((g) => g.types));

/** Types that fall into no group — so the "Other" filter does not hide events
 *  that are added in devd before they are added here. */
export const ungroupedTypes = (all: string[]): string[] => all.filter((t) => !GROUPED.has(t));

/** Selected groups (+ "other") → concrete list of types for the server query.
 *  Empty selection = no filter, i.e. an empty array (the server then applies no filter). */
export function typesForGroups(selected: string[], allTypes: string[]): string[] {
  if (selected.length === 0) return [];
  const out = new Set<string>();
  for (const id of selected) {
    if (id === "other") { for (const t of ungroupedTypes(allTypes)) out.add(t); continue; }
    for (const t of LOG_GROUPS.find((g) => g.id === id)?.types ?? []) out.add(t);
  }
  // A filter on types not present in the data would return nothing — keep only existing ones.
  const known = new Set(allTypes);
  const hit = [...out].filter((t) => known.has(t));
  // A selected group without a single existing type must stay a filter (= nothing),
  // otherwise after ticking it the user would see EVERYTHING instead of nothing.
  return hit.length > 0 ? hit : ["__none__"];
}

/** Toggle an item in a multi-select. */
export function toggle(selected: string[], id: string): string[] {
  return selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id];
}

/** How many pages for a given record count (never 0 — an empty log has 1 page). */
export const pageCount = (total: number, perPage: number): number => Math.max(1, Math.ceil(total / perPage));
