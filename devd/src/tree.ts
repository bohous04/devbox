import { existsSync } from "node:fs";
import { join } from "node:path";
import type { DevConfig, Provider, ProjectCfg, RepoRef, Source } from "./config";
import type { AgentName, SessionRow } from "./db";
import { run as runProc, timeoutFor } from "./proc";

// `bare` = the repo is in the new form (bare clone), so EVERY session over it gets
// its own worktree and branch. Without it (the old shared workspace) a second session does get
// its own container, but over THE SAME files and the same branch — and the UI must say so, not promise
// the opposite. Optional: an older devd does not send it and the client interprets that as the old form.
export interface TreeRepo { name: string; cloneUrl: string; provider: Provider; cloned: boolean; bare?: boolean; agent?: AgentName | null }
// soloAgent = the remembered choice for claudeSolo of the given project; claudeSolo is not
// a real repo (the pickers offer it synthetically), so the memory hangs on the project.
export interface TreeProject { folder: string; project: string; repos: TreeRepo[]; soloAgent?: AgentName | null }
export type Lister = (src: Source) => Promise<TreeRepo[]>;

export function workspacePath(root: string, folder: string, project: string, repo: string): string {
  return project === folder ? join(root, folder, repo) : join(root, folder, project, repo);
}

/** Bare clone of the repo: `<root>/<folder>/<project>/<repo>.git`. Without a working directory,
 *  so no branch is checked out in it and every worktree can take any of them
 *  — including the default one. */
export function barePath(root: string, folder: string, project: string, repo: string): string {
  return `${workspacePath(root, folder, project, repo)}.git`;
}

/** Is this repo in the new form? Based on the DISK, not on the session — existing repos
 *  stay the old way and both must work side by side. */
export function isBareLayout(root: string, folder: string, project: string, repo: string): boolean {
  return existsSync(barePath(root, folder, project, repo));
}

/** The directory where the session actually has its files. A worktree session has it elsewhere than
 *  in the repo tree, and `workspacePath` would point to a nonexistent path for it — which
 *  shows up not as an error but as an empty diff and zero statistics.
 *  `worktree === null` is a repo cloned the old way with a shared directory. */
export function sessionWorkdir(root: string, s: SessionRow): string {
  return s.worktree ?? workspacePath(root, s.folder, s.project, s.repo);
}

function refToRepo(r: RepoRef): TreeRepo {
  const cloneUrl = r.cloneUrl ?? (r.provider === "github" && r.repo ? `https://github.com/${r.repo}.git` : "");
  return { name: r.name, cloneUrl, provider: r.provider, cloned: false };
}

async function projectRepos(p: ProjectCfg, listers: { github: Lister; gitea: Lister }): Promise<TreeRepo[]> {
  const out = new Map<string, TreeRepo>();
  for (const ref of p.repos ?? []) out.set(ref.name, refToRepo(ref));
  for (const src of p.sources ?? []) {
    const listed = await (src.provider === "github" ? listers.github(src) : listers.gitea(src));
    for (const r of listed) if (!out.has(r.name)) out.set(r.name, r);
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function buildTree(cfg: DevConfig, root: string, listers: { github: Lister; gitea: Lister }): Promise<TreeProject[]> {
  const tree: TreeProject[] = [];
  for (const [folder, fc] of Object.entries(cfg.folders)) {
    if (fc.projects) {
      for (const [project, pc] of Object.entries(fc.projects)) {
        tree.push({ folder, project, repos: await projectRepos(pc, listers) });
      }
    }
    if (fc.repos || fc.sources) {
      tree.push({ folder, project: folder, repos: await projectRepos(fc, listers) });
    }
  }
  // Cloned = an old workspace exists, OR a bare clone of the new form. Without the second
  // condition a repo in the new form would look uncloned in the picker and would offer
  // a button that would clone it a second time into the old form next to the bare clone.
  for (const p of tree) for (const r of p.repos) {
    r.bare = isBareLayout(root, p.folder, p.project, r.name);
    r.cloned = existsSync(workspacePath(root, p.folder, p.project, r.name)) || r.bare;
  }
  return tree;
}

export function resolveTarget(tree: TreeProject[], query: string): { folder: string; project: string; repo: TreeRepo }[] {
  const [a, b] = query.split("/");
  const out: { folder: string; project: string; repo: TreeRepo }[] = [];
  for (const p of tree) {
    for (const r of p.repos) {
      if (b !== undefined ? p.project === a && r.name === b : r.name === a) {
        out.push({ folder: p.folder, project: p.project, repo: r });
      }
    }
  }
  return out;
}

export async function ghLister(src: Source): Promise<TreeRepo[]> {
  const owner = src.org ?? src.user ?? "";
  const args = ["repo", "list", owner, "--limit", "200", "--json", "name,url,visibility"];
  const r = await runProc(["gh", ...args], { timeoutMs: timeoutFor("NET_CLI") });
  if (r.timedOut) throw new Error(`gh repo list ${owner} timed out`);
  if (r.code !== 0) throw new Error(`gh repo list ${owner} failed: ${r.stderr.trim()}`);
  const rows = JSON.parse(r.stdout) as { name: string; url: string; visibility: string }[];
  return rows
    .filter((x) => !src.visibility || src.visibility === "all" || x.visibility.toLowerCase() === src.visibility)
    .map((x) => ({ name: x.name, cloneUrl: `${x.url}.git`, provider: "github" as const, cloned: false }));
}

export function giteaLister(getInstances: () => { name: string; url: string }[], tokens: Record<string, string>): Lister {
  return async (src) => {
    const instances = getInstances(); // fresh — the config may have changed from the dashboard
    let inst: { name: string; url: string } | undefined;
    if (src.instance !== undefined) {
      inst = instances.find((i) => i.name === src.instance);
      if (!inst) throw new Error(`Unknown Gitea instance: ${src.instance}`);
    } else {
      inst = instances[0];
    }
    if (!inst) throw new Error("No Gitea instance configured");
    const token = tokens[inst.name] ?? "";
    const owner = src.org ?? src.user ?? "";
    const kind = src.org ? "orgs" : "users";
    const res = await fetch(`${inst.url}/api/v1/${kind}/${owner}/repos?limit=50`, {
      headers: token ? { Authorization: `token ${token}` } : {},
    });
    if (!res.ok) throw new Error(`Gitea list failed: ${res.status}`);
    const rows = (await res.json()) as { name: string; clone_url: string }[];
    return rows.map((x) => ({ name: x.name, cloneUrl: x.clone_url, provider: "gitea" as const, cloned: false }));
  };
}
