import { closeSync, constants as C, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, writeFileSync, writeSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { openDirNoFollow, withDir, writeFileAt, type DirHandle } from "./noFollowFs";

const SAFE = /[^A-Za-z0-9._-]/g;

// Only basename, safe characters, no leading dots (hidden / .. ). Invalid → null.
export function sanitizeName(raw: string): string | null {
  const base = basename(raw).replace(/^\.+/, "");
  const cleaned = base.replace(SAFE, "_");
  if (!cleaned || /^_+$/.test(cleaned)) return null;
  return cleaned;
}

export function uniquePath(dir: string, name: string, exists: (p: string) => boolean = existsSync): string {
  if (!exists(join(dir, name))) return join(dir, name);
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 1; ; i++) {
    const cand = join(dir, `${stem}-${i}${ext}`);
    if (!exists(cand)) return cand;
  }
}

const lexists = (p: string): boolean => { try { lstatSync(p); return true; } catch { return false; } };

// Creates <workspace>/.inbox and (when the repo is git) adds .inbox/ to .git/info/exclude,
// so the files do not clutter `git status`. Does not touch the committed .gitignore.
// The workspace is agent-writable and devd runs as root: nothing below it is followed through a
// symlink (noFollowFs.ts) — a planted `.inbox` link is an error, a planted exclude link is skipped.
export function ensureInbox(workspace: string): string {
  withDir(workspace, [".inbox"], true, () => {});
  addInboxExclude(workspace);
  return join(workspace, ".inbox");
}

function addInboxExclude(workspace: string): void {
  let info: DirHandle;
  try { info = openDirNoFollow(workspace, [".git", "info"]); }
  catch (e) {
    // No .git/info (not a git repo, or a worktree whose .git is a file): nothing to exclude.
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") console.warn(`inbox: ${workspace}/.git/info skipped (${code})`);
    return;
  }
  try {
    let fd: number;
    // O_NONBLOCK: a planted FIFO must not hang the open.
    try { fd = openSync(join(info.path, "exclude"), C.O_RDWR | C.O_APPEND | C.O_CREAT | C.O_NOFOLLOW | C.O_NONBLOCK, 0o644); }
    catch (e) { console.warn(`inbox: ${workspace}/.git/info/exclude skipped (${(e as NodeJS.ErrnoException).code})`); return; }
    try {
      const st = fstatSync(fd);
      if (!st.isFile() || st.size > 1024 * 1024) { console.warn(`inbox: ${workspace}/.git/info/exclude is not a small regular file, skipped`); return; }
      const buf = Buffer.alloc(st.size);
      const cur = buf.subarray(0, readSync(fd, buf, 0, st.size, 0)).toString("utf8");
      if (!cur.split("\n").includes(".inbox/")) writeSync(fd, (cur === "" || cur.endsWith("\n") ? "" : "\n") + ".inbox/\n");
    } finally { closeSync(fd); }
  } finally { info.close(); }
}

export function stageFile(workspace: string, rawName: string, bytes: Uint8Array): string {
  const name = sanitizeName(rawName);
  if (!name) throw new Error("invalid file name");
  ensureInbox(workspace);
  return withDir(workspace, [".inbox"], false, (d) => {
    const target = basename(uniquePath(d.path, name, lexists));
    writeFileAt(d, target, bytes, { mode: 0o644 });
    return "/workspace/.inbox/" + target;
  });
}

// Shared inbox: the file goes into the host's `sharedDir` (= <root>/_inbox), which is
// bind-mounted into EVERY container as /inbox. The path is uniform across
// sessions → we do not have to guess the target session on the mac (see push model / hotkey).
/** A shared-inbox name the user must change (the API answers 400 with the message). */
export class InboxNameError extends Error {}

/** `isSessionId`: `<sharedDir>/<session id>` is that session's chat-image directory (threadImages.ts), so a shared
 *  file may not take a session's id as its name. */
export function stageShared(sharedDir: string, rawName: string, bytes: Uint8Array, isSessionId: (name: string) => boolean): string {
  const name = sanitizeName(rawName);
  if (!name) throw new Error("invalid file name");
  mkdirSync(sharedDir, { recursive: true });
  if (!lstatSync(sharedDir).isDirectory()) throw new Error("inbox must be a directory, not a symlink");
  const target = uniquePath(sharedDir, name);
  if (isSessionId(name) || isSessionId(basename(target))) {
    throw new InboxNameError(`"${basename(target)}" is the id of a session; rename the file (e.g. add an extension)`);
  }
  writeFileSync(target, bytes, { flag: "wx" });
  return "/inbox/" + basename(target);
}
