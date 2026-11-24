// Continuing an ended Codex session (POST /api/ended/:id/continue) needs its conversation where the new session's
// Codex will look for it. A chat session's lives in the codex-v2-shared volume (sessions.ts codexV2Mounts); devd
// looks before it promises a resume, so a conversation that is gone hands off the ended transcript with the reason
// instead of opening an empty thread.
import type { CodexAuthDeps } from "./agentAuth";

const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHARED_VOLUME = "codex-v2-shared";

/** Why the chat Codex conversation `thread` cannot be continued, null when its rollout is in the shared home. */
export async function sharedRolloutBlock(d: CodexAuthDeps, thread: string): Promise<string | null> {
  if (!THREAD_ID.test(thread)) return "the Codex conversation id is not valid";
  const gone = `the Codex conversation ${thread} is no longer in the shared Codex home`;
  // Mounting a missing volume would create it.
  const listed = await d.run(["volume", "ls", "--format", "{{.Name}}"]);
  if (listed.code !== 0) return "devd could not list the Docker volumes to find the conversation";
  if (!listed.stdout.split(/\r?\n/).some((v) => v.trim() === SHARED_VOLUME)) return gone;
  const shared = "/home/dev/.codex-v2/shared";
  const r = await d.run(["run", "--rm", "--network", "none", "-v", `${SHARED_VOLUME}:/home/dev/.codex-v2:ro`, d.image ?? "devbox:latest", "sh", "-c",
    `find ${shared}/sessions ${shared}/archived_sessions -type f -name 'rollout-*-${thread}.jsonl' 2>/dev/null; true`]);
  if (r.code !== 0) return `devd could not check the shared Codex home for the conversation: ${(r.stderr.trim() || `docker run failed (exit ${r.code})`).slice(0, 300)}`;
  return r.stdout.trim() === "" ? gone : null;
}
