// The agent-writable repos under devd's root, for the one-time ownership fix and the startup check
// that came with running host git as the agent uid (safeGit.ts layer 4). Before that, root's git
// wrote FETCH_HEAD, packs, ORIG_HEAD… into these repos; git as the agent uid cannot rewrite them.
import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { AGENT_UID, classifyGitTarget } from "./safeGit";
import { discoverRepos } from "./unpushed";

// A real directory reached without any symlink on the way (realpath unchanged, root canonical).
const isRealDir = (p: string): boolean => { try { return lstatSync(p).isDirectory() && realpathSync(p) === p; } catch { return false; } };

/** Bare clones and workspaces (the same walk as discoverRepos) plus `_sessions/<id>` worktrees.
 *  Anything reached through a symlink is left out: its target is not ours to chown. Each one is checked against the
 *  classifier host git uses, so this list and layer 4 cannot drift apart. */
export function agentRepoDirs(root: string): string[] {
  root = realpathSync(root);
  const repos = discoverRepos(root).map((r) => r.path);
  const sessions = join(root, "_sessions");
  let ids: string[] = [];
  try { ids = readdirSync(sessions); } catch { /* no sessions yet */ }
  const worktrees = ids.map((id) => join(sessions, id)).filter((p) => existsSync(join(p, ".git")));
  const dirs = [...repos, ...worktrees].filter(isRealDir).sort();
  for (const d of dirs) {
    if (classifyGitTarget(d, root) !== "agent") throw new Error(`${d} is not an agent git target`);
  }
  return dirs;
}

/** Entries (the dir itself included) not owned by `uid`, walked with lstat: links are counted, not followed. */
function foreignEntries(dir: string, uid: number): number {
  let n = 0;
  const stack = [dir];
  while (stack.length) {
    const p = stack.pop()!;
    const st = lstatSync(p);
    if (st.uid !== uid) n++;
    if (st.isDirectory()) for (const name of readdirSync(p)) stack.push(join(p, name));
  }
  return n;
}

export interface RepoOwnership { path: string; foreign: number }

/** Dry run (default): per repo, how many entries are not the agent uid's. `apply`: then
 *  `chown -h -R -P` exactly those repo dirs (never their parents, never through links). */
export async function ownAgentRepos(root: string, o: { apply: boolean; agentUid?: number; chown: (argv: string[]) => Promise<void> }): Promise<RepoOwnership[]> {
  const uid = o.agentUid ?? AGENT_UID;
  const report = agentRepoDirs(root).map((path) => ({ path, foreign: foreignEntries(path, uid) }));
  if (o.apply) {
    for (const r of report) {
      if (r.foreign > 0) await o.chown(["chown", "-h", "-R", "-P", `${AGENT_UID}:${AGENT_UID}`, "--", r.path]);
    }
  }
  return report;
}

/** Cheap check for startup: the repo dir and its key git files. A full walk is the tool's job. */
export function ownershipHints(root: string, uid: number = AGENT_UID): string[] {
  return agentRepoDirs(root).filter((dir) => {
    const gitDir = existsSync(join(dir, "HEAD")) && !existsSync(join(dir, ".git")) ? dir : join(dir, ".git");
    return [dir, ...["", "HEAD", "config", "FETCH_HEAD", "ORIG_HEAD", "index", "packed-refs"].map((f) => join(gitDir, f))]
      .some((p) => { try { return lstatSync(p).uid !== uid; } catch { return false; } });
  });
}

/** The root and each of its parents that the agent uid cannot enter (no search permission for
 *  it): host git as that uid fails in every repo below them. */
export function untraversableForAgent(root: string, uid: number = AGENT_UID, gid: number = AGENT_UID): string[] {
  const out: string[] = [];
  for (let p = realpathSync(root); ; p = dirname(p)) {
    const st = lstatSync(p);
    const bit = st.uid === uid ? 0o100 : st.gid === gid ? 0o010 : 0o001;
    if (!(st.mode & bit)) out.push(p);
    if (p === dirname(p)) break;
  }
  return out;
}
