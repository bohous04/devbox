export interface DbRequestReq {
  id: number; wanted: string; why: string;
  project?: string | null; session?: string | null;
  /** The request came from a shared (or previously shared) session — the terminal guest may have sent it. */
  shared?: boolean;
}

const DENY = "Deny";
const LATER = "Later";
const OPEN = "Open";

function esc(s: string): string {
  return s.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", " ");
}

/** The dialog offers only deny and open dashboard — approval requires filling in the
 *  server, container name and port, which does not reasonably fit a native dialog
 *  and a typo would create a role with the wrong name in production.
 *
 *  Lines are joined via `& return &` (see sshPrompt.ts) and escaped one by one,
 *  so the agent cannot fake a line structure with its own `why`. */
export function dbDialogScript(r: DbRequestReq): string {
  const where = r.project ?? r.session ?? "unknown session";
  const lines = [
    `Database: ${r.wanted}`,
    `Session: ${where}${r.shared === true ? " (from a shared session)" : ""}`,
    ...(r.shared === true ? ["This session is or was shared — the request may come from a terminal guest, not your agent."] : []),
    "",
    "The agent claims:",
    r.why || "(no reason given)",
  ];
  const message = lines.map((l) => `"${esc(l)}"`).join(" & return & ");
  return [
    `display dialog ${message}`,
    ` with title "${r.shared === true ? "Devbox: database request from a shared session" : "Devbox: agent wants database access"}"`,
    ` buttons {"${DENY}", "${LATER}", "${OPEN}"}`,
    // The default is "Later": a closed dialog or a timeout must not decide anything.
    ` default button "${LATER}" with icon caution giving up after 85`,
  ].join("");
}

export function parseDbAnswer(stdout: string): { decision: "deny" | "open" } | null {
  const btn = stdout.match(/button returned:([^,\n]*)/)?.[1]?.trim();
  if (btn === DENY) return { decision: "deny" };
  if (btn === OPEN) return { decision: "open" };
  return null;   // Later / closed / timeout → nothing
}
