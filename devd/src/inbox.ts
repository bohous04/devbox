import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";

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

// Creates <workspace>/.inbox and (when the repo is git) adds .inbox/ to .git/info/exclude,
// so the files do not clutter `git status`. Does not touch the committed .gitignore.
export function ensureInbox(workspace: string): string {
  const dir = join(workspace, ".inbox");
  mkdirSync(dir, { recursive: true });
  const info = join(workspace, ".git", "info");
  if (existsSync(info)) {
    const exclude = join(info, "exclude");
    const cur = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
    if (!cur.split("\n").includes(".inbox/")) {
      appendFileSync(exclude, (cur === "" || cur.endsWith("\n") ? "" : "\n") + ".inbox/\n");
    }
  }
  return dir;
}

export function stageFile(workspace: string, rawName: string, bytes: Uint8Array): string {
  const name = sanitizeName(rawName);
  if (!name) throw new Error("invalid file name");
  const dir = ensureInbox(workspace);
  const target = uniquePath(dir, name);
  writeFileSync(target, bytes);
  return "/workspace/.inbox/" + basename(target);
}

// Shared inbox: the file goes into the host's `sharedDir` (= <root>/_inbox), which is
// bind-mounted into EVERY container as /inbox. The path is uniform across
// sessions → we do not have to guess the target session on the mac (see push model / hotkey).
export function stageShared(sharedDir: string, rawName: string, bytes: Uint8Array): string {
  const name = sanitizeName(rawName);
  if (!name) throw new Error("invalid file name");
  mkdirSync(sharedDir, { recursive: true });
  const target = uniquePath(sharedDir, name);
  writeFileSync(target, bytes);
  return "/inbox/" + basename(target);
}
