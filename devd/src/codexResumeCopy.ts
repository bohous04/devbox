// Continuing an ended tmux Codex session (DEVBOX-100): its conversation sits in the home of the Codex account it ran
// on, and the new session's `co` starts on whatever account devd selects then. Continue copies the conversation into
// that account's home first (codexConversationTransfer.py `copy`: the source is only read), so the new session resumes
// it there; anything that stops the copy is the reason continue hands off instead.
// The dashboard's typecheck reaches this file through api.ts and does not include devd's declarations otherwise.
/// <reference path="./pythonText.d.ts" />
import transferProgram from "./codexConversationTransfer.py" with { type: "text" };
import type { CodexAuthDeps } from "./agentAuth";
import { CODEX_PROFILE_ROOT, codexAccountVolume } from "./codexAccountProfiles";
import { CODEX_ACCOUNT_ID } from "./endedSessions";

const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Where a session container mounts the account's home (sessions.ts accountMounts, image/codex-account-env.sh). */
const homeOf = (id: string) => (id === "default" ? "/home/dev/.codex" : `${CODEX_PROFILE_ROOT}/${id}`);

/** Copies `thread` from account `from`'s home into `to`'s, in a throwaway container of the session image that mounts
 *  both homes at the paths sessions use (the threads' rows name their rollouts by those paths). `{ account }`: the new
 *  session resumes it there; `{ reason }`: why not. */
export async function copyCodexConversation(d: CodexAuthDeps, from: string, to: { accountId: string; label: string }, thread: string): Promise<{ account: string } | { reason: string }> {
  if (!CODEX_ACCOUNT_ID.test(from) || !CODEX_ACCOUNT_ID.test(to.accountId) || !THREAD_ID.test(thread)) {
    return { reason: "the Codex conversation or account id is not valid" };
  }
  // Mounting a missing volume would create an empty one.
  const listed = await d.run(["volume", "ls", "--format", "{{.Name}}"]);
  if (listed.code !== 0) return { reason: "devd could not list the Codex account volumes" };
  const volumes = new Set(listed.stdout.split(/\r?\n/).map((v) => v.trim()));
  if (!volumes.has(codexAccountVolume(from))) return { reason: `the Codex account ${from} that held the conversation no longer exists` };
  if (!volumes.has(codexAccountVolume(to.accountId))) return { reason: `the Codex account ${to.label} has no home to copy the conversation into` };
  const mounts = [...new Set([from, to.accountId])].flatMap((id) => ["-v", `${codexAccountVolume(id)}:${homeOf(id)}`]);
  const r = await d.run(["run", "--rm", "--network", "none", ...mounts, d.image ?? "devbox:latest",
    "python3", "-I", "-c", transferProgram, "copy", "--source-home", homeOf(from), "--target-home", homeOf(to.accountId), "--thread-id", thread]);
  let out: { ok?: unknown; threadId?: unknown; error?: unknown } | null = null;
  try { out = JSON.parse(r.stdout); } catch { out = null; }
  if (out?.ok === true && out.threadId === thread && r.code === 0) return { account: to.accountId };
  // The helper's errors are fixed sentences (TransferError); anything else stays out of the reason.
  // Without its full stop: the reason goes into a sentence (endedSessions.ts handoffPrompt).
  const why = typeof out?.error === "string" ? out.error.replace(/\.$/, "") : `the copy gave no result (exit ${r.code})`;
  return { reason: `the Codex conversation could not be copied to the account ${to.label}: ${why}` };
}
