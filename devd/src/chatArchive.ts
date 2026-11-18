import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

/** Moves a session's Claude transcripts (`_claude-projects/<id>`) to `_chat-archive/<id>-<stamp>`
 *  when the session ends. The user returns to old conversations; the rest of the session's
 *  files go. Same filesystem, so this is a rename, not a copy. Returns the archive path, or
 *  null when there was nothing to keep (the empty directory is removed). A failed rename
 *  throws: the transcripts then stay where they are rather than being deleted.
 *
 *  A chat session's thread store (`_threads/<id>.sqlite` plus `-wal`/`-shm`) moves into the same
 *  archive directory after the transcripts (a failed move leaves it in `_threads`); the caller closes the store
 *  first. Without a store file nothing changes. */
export function archiveChats(root: string, id: string, now: Date): string | null {
  const src = join(root, "_claude-projects", id);
  let entries: string[];
  try { entries = readdirSync(src); } catch { entries = []; }
  const threadFiles = ["", "-wal", "-shm"].map((x) => join(root, "_threads", `${id}.sqlite${x}`)).filter((f) => existsSync(f));
  if (!entries.length && !threadFiles.length) {
    rmSync(src, { recursive: true, force: true });
    return null;
  }
  const stamp = now.toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
  const dest = join(root, "_chat-archive", `${id}-${stamp}`);
  if (entries.length) {
    // One rename of the whole directory: a failure cannot split the transcripts between two places.
    mkdirSync(join(root, "_chat-archive"), { recursive: true });
    renameSync(src, dest);
  } else {
    mkdirSync(dest, { recursive: true });
    rmSync(src, { recursive: true, force: true });
  }
  for (const f of threadFiles) renameSync(f, join(dest, f.slice(f.lastIndexOf("/") + 1)));
  return dest;
}
