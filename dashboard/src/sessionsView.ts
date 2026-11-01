import type { SwitchAgentResponse } from "./api";

// Agent switch returns failure as HTTP 200 too (same as switch-account) —
// ConfirmButton reports an error only via throw, so the response is translated into a sentence.
// null = full success, throw nothing. Partial success (some panes stayed on the
// old profile) is reported too — silence would look like "everything switched".
export function agentSwitchError(r: SwitchAgentResponse, label: string): string | null {
  const stragglers = r.panes.filter((p) => p.outcome !== "restarted");
  const detail = stragglers.map((p) => `${p.target} (${p.outcome})`).join(", ");
  switch (r.status) {
    case "unchanged": return null;
    case "no-agent": return "No running agent found in the session — nothing switched.";
    case "failed": return `Couldn't switch any panel onto ${label}${detail ? `: ${detail}` : " — check the container"}.`;
    case "switched": return detail ? `Switched to ${label}, but some panes stayed behind: ${detail}.` : null;
  }
}
