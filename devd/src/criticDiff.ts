import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { sh } from "./git";

export interface TurnDiff {
  diff: string;
  newFiles: { path: string; content: string }[];
  truncated: string[];
}

// devd runs as root over a workspace owned by uid 1000 → without safe.directory
// git would end with "detected dubious ownership" (same as collectGitStats).
async function git(ws: string, ...args: string[]) {
  return sh(ws, "git", "-c", `safe.directory=${ws}`, ...args);
}

/** SHA of the current HEAD, or null for a repo without commits / outside git. */
export async function headSha(ws: string): Promise<string | null> {
  const r = await git(ws, "rev-parse", "HEAD");
  const out = r.stdout.trim();
  return r.code === 0 && /^[0-9a-f]{40}$/.test(out) ? out : null;
}

const PER_FILE = 64 * 1024;
const TOTAL = 256 * 1024;

/**
 * Input for the critic: what changed in the repo since the start of the turn.
 *
 * `git diff <baseline>` compares the WORKING TREE against the baseline, so a single
 * command also covers commits the agent made during the turn. Untracked files
 * are not in the diff, so they are attached separately (with a limit — the critic does not need
 * to see a 5 MB build artifact, only that it was created).
 */
export async function collectTurnDiff(ws: string, baseline: string | null, limits: { perFile?: number; total?: number } = {}): Promise<TurnDiff> {
  const perFile = limits.perFile ?? PER_FILE;
  const total = limits.total ?? TOTAL;
  const d = baseline ? await git(ws, "diff", baseline) : { code: 0, stdout: "", stderr: "" };
  // baseline === null is a legitimate case (repo without commits) → empty diff.
  // Conversely, baseline !== null with a failing `git diff` (e.g. the baseline SHA does not
  // exist in the repo) MUST NOT silently turn into "no changes" — the caller (critic) would
  // then let the turn pass even though we really do not know what changed.
  if (baseline && d.code !== 0) throw new Error(`git diff against baseline failed: ${d.stderr.trim()}`);
  const diff = d.stdout;
  const newFiles: { path: string; content: string }[] = [];
  const truncated: string[] = [];
  let budget = total - diff.length;
  // -z: NUL-delimited, without C-quoting/octal escaping of paths. Without -z
  // git status would wrap non-ASCII names (diacritics) in quotes with escapes and
  // statSync/readFileSync would not find the file under such a "path".
  const status = await git(ws, "status", "--porcelain", "-uall", "-z");
  for (const entry of status.stdout.split("\0")) {
    if (!entry.startsWith("?? ")) continue;
    const path = entry.slice(3);
    if (!path) continue;
    let size: number;
    try { size = statSync(join(ws, path)).size; } catch { continue; }
    if (size > perFile || size > budget) { truncated.push(path); continue; }
    const raw = (() => { try { return readFileSync(join(ws, path)); } catch { return null; } })();
    if (raw === null) { truncated.push(path); continue; }   // unreadable → just a mention
    if (isBinary(raw)) { truncated.push(path); continue; }  // binary → just a mention, not garbled text
    const content = raw.toString("utf8");
    newFiles.push({ path, content });
    budget -= content.length;
  }
  return { diff, newFiles, truncated };
}

// readFileSync(path, "utf8") would silently replace invalid bytes with U+FFFD, so
// a binary within the size limit ends up (garbled, but whole) in newFiles and goes
// straight into the critic prompt. Detection: a NUL byte (typical for binaries), or
// content that does not round-trip unchanged through a UTF-8 decoder.
function isBinary(buf: Buffer): boolean {
  if (buf.includes(0)) return true;
  const decoded = buf.toString("utf8");
  return Buffer.compare(Buffer.from(decoded, "utf8"), buf) !== 0;
}

export function isEmptyTurnDiff(d: TurnDiff): boolean {
  return d.diff.trim() === "" && d.newFiles.length === 0 && d.truncated.length === 0;
}

/** Text form for the critic prompt. */
export function renderTurnDiff(d: TurnDiff): string {
  const parts: string[] = [];
  if (d.diff.trim()) parts.push(`--- git diff ---\n${d.diff}`);
  for (const f of d.newFiles) parts.push(`--- new file: ${f.path} ---\n${f.content}`);
  if (d.truncated.length) parts.push(`--- new files not shown (binary or too large) ---\n${d.truncated.join("\n")}`);
  return parts.join("\n\n");
}
