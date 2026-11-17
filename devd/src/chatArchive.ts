import { mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

/** Moves a session's Claude transcripts (`_claude-projects/<id>`) to `_chat-archive/<id>-<stamp>`
 *  when the session ends. The user returns to old conversations; the rest of the session's
 *  files go. Same filesystem, so this is a rename, not a copy. Returns the archive path, or
 *  null when there was nothing to keep (the empty directory is removed). A failed rename
 *  throws: the transcripts then stay where they are rather than being deleted. */
export function archiveChats(root: string, id: string, now: Date): string | null {
  const src = join(root, "_claude-projects", id);
  let entries: string[];
  try { entries = readdirSync(src); } catch { return null; }
  if (!entries.length) {
    rmSync(src, { recursive: true, force: true });
    return null;
  }
  const stamp = now.toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
  const dest = join(root, "_chat-archive", `${id}-${stamp}`);
  mkdirSync(join(root, "_chat-archive"), { recursive: true });
  renameSync(src, dest);
  return dest;
}
