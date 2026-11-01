export interface SshApprovalReq {
  id: string; title: string; why: string;
  target?: string | null; cwd?: string | null; project?: string | null; repo?: string | null;
  /** The request came from a shared (or previously shared) session — the terminal guest may have sent it. */
  shared?: boolean;
}

const DENY = "Deny";
const OK = "Approve";
const OK_60 = "Approve for 60 min";

function esc(s: string): string {
  return s.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", " ");
}

/** Facts held by devd — the key (verified against 1Password) and the project/repo from the session —
 *  are at the top; the target, like `why` and `cwd`, is chosen by the container/agent, so it is
 *  under its own heading in the dialog, not among the verified facts.
 *
 *  Lines are joined into AppleScript via `& return &`, not as one `\n`-joined
 *  string: AppleScript does not understand `\n` inside a `"..."` literal (hence `esc()` below,
 *  which turns newline into a space), but the `return` constant can be concatenated. Without this
 *  the whole dialog showed up as one continuous line and thus broke exactly the separation
 *  of verified facts from agent claims that the dialog is split into sections for
 *  (a review finding). EVERY line is escaped separately, so `esc()`'s "\n"→" " mapping
 *  still applies inside an individual value (`why` can have multiple lines) — the agent thus
 *  cannot fake a line structure through its own `why`/`target`/`cwd`. */
export function sshDialogScript(r: SshApprovalReq): string {
  const where = r.project && r.repo ? `${r.project}/${r.repo}` : "unknown session";
  const lines = [
    `Key: ${r.title}`,
    `Session: ${where}${r.shared === true ? " (from a shared session)" : ""}`,
    ...(r.shared === true ? ["This session is or was shared — the request may come from a terminal guest, not your agent."] : []),
    "",
    "The agent claims:",
    r.why,
    ...(r.target ? [`Target: ${r.target}`] : []),
    ...(r.cwd ? [`(from ${r.cwd})`] : []),
  ];
  const message = lines.map((l) => `"${esc(l)}"`).join(" & return & ");
  return [
    `display dialog ${message}`,
    ` with title "${r.shared === true ? "Devbox: SSH key request from a shared session" : "Devbox: agent wants an SSH key"}"`,
    ` buttons {"${DENY}", "${OK}", "${OK_60}"}`,
    ` default button "${DENY}" with icon caution giving up after 85`,
  ].join("");
}

export function parseDialogAnswer(stdout: string): { decision: "approve" | "deny"; grantMinutes: number } | null {
  const btn = stdout.match(/button returned:([^,\n]*)/)?.[1]?.trim();
  if (btn === OK_60) return { decision: "approve", grantMinutes: 60 };
  if (btn === OK) return { decision: "approve", grantMinutes: 0 };
  if (btn === DENY) return { decision: "deny", grantMinutes: 0 };
  return null; // closed / timeout / unintelligible → nothing (fail-closed)
}
