import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { run, timeoutFor, type RunResult } from "./proc";

/** Unpushed commits across the whole workspace (`/srv/dev`), for the "Work in
 *  progress" page in the dashboard. One commit = a commit reachable from some local branch
 *  but from NO remote-tracking ref (`--branches --not --remotes`). That covers:
 *
 *  - a repo in the old form (shared workspace with a `.git` directory),
 *  - a bare clone of the new form (`<repo>.git`) — the session branches (`session/<repo>-N`) live
 *    in its `refs/heads`, so the worktrees in `_sessions/` do not need to be walked separately,
 *  - `claudeSolo-N` and other local repos WITHOUT a remote: there everything is unpushed and
 *    `noRemote` names it in the UI (see games/claudeSolo-1 with 41 local-only commits).
 *
 *  Uncommitted work (a dirty tree) does NOT belong here — the user wants commits and their titles.
 *
 *  Everything via `proc.run` (async, with a timeout): devd is single-threaded and a scan of dozens
 *  of repos with dozens of branches via `spawnSync` would block the whole HTTP server (same trap
 *  as with `/api/tree`, see cache.ts). The caller additionally wraps this in `memoAsync`. */

export interface UnpushedCommit { hash: string; subject: string; at: number; author: string }
export interface UnpushedBranch {
  branch: string;
  /** `origin/main` etc.; `null` = a branch without an upstream (typically a feature branch that
   *  has never been pushed yet). */
  upstream: string | null;
  /** Exact count — `commits` below is truncated to `limit`. */
  count: number;
  commits: UnpushedCommit[];
  truncated: boolean;
}
/** Where the repo pushes. `github`/`gitea` can create a PR; `other` (local path, foreign
 *  host) can only push. A Gitea instance host is recognized from the config (`giteaInstances`). */
export interface RemoteInfo { provider: "github" | "gitea" | "other"; url: string; host: string; owner: string; name: string }
export interface UnpushedRepo {
  folder: string; project: string; repo: string; path: string; bare: boolean;
  /** The repo has no remote — "unpushed" means "everything" here. */
  noRemote: boolean;
  count: number;
  branches: UnpushedBranch[];
  /** git does not work in that directory (broken worktree registration etc.). The counts are
   *  then zero, but the repo shows up in the report with an error instead of being silently omitted. */
  error?: string;
  /** Origin and the remote's default branch — only for repos with something to push (the UI uses it
   *  to show Push / Create PR). `null` = no remote. */
  remote?: RemoteInfo | null;
  base?: string;
}
export interface UnpushedFolder { folder: string; count: number; repos: UnpushedRepo[] }
export interface UnpushedReport {
  at: number;
  /** Sum across all folders. */
  total: number;
  /** How many repos were scanned (clean ones too) — so the UI shows that the scan found something. */
  scanned: number;
  /** Only folders with something to report (or where some repo failed). */
  folders: UnpushedFolder[];
}

export interface DiscoveredRepo { folder: string; project: string; repo: string; path: string; bare: boolean }

const DEFAULT_LIMIT = 30;

/** Workspace layout: `<root>/<folder>/<repo>` (flat, project === folder) or
 *  `<root>/<folder>/<project>/<repo>`; a bare clone is `<repo>.git` in the same place
 *  (see tree.ts `workspacePath`/`barePath`). The DISK is walked, not the config — local
 *  repos outside the config (claudeSolo-N, manually cloned) have unpushed work too.
 *  Underscore (`_sessions`, `_inbox`, `_pre-migration-*`) and hidden directories are
 *  skipped; `_sessions` are worktrees whose branches are already covered by the bare clone. */
export function discoverRepos(root: string): DiscoveredRepo[] {
  const out: DiscoveredRepo[] = [];
  for (const folder of listDirs(root)) {
    const folderPath = join(root, folder);
    for (const entry of listDirs(folderPath)) {
      const p = join(folderPath, entry);
      const repo = asRepo(p, entry);
      if (repo) { out.push({ folder, project: folder, ...repo }); continue; }
      // Not a repo → a project; the repos are one level below.
      for (const sub of listDirs(p)) {
        const r = asRepo(join(p, sub), sub);
        if (r) out.push({ folder, project: entry, ...r });
      }
    }
  }
  return out.sort((a, b) => a.folder.localeCompare(b.folder) || a.project.localeCompare(b.project) || a.repo.localeCompare(b.repo) || Number(a.bare) - Number(b.bare));
}

function listDirs(dir: string): string[] {
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  return names
    .filter((n) => !n.startsWith("_") && !n.startsWith("."))
    // lstat: a symlink (e.g. one the agent made inside its workspace) is never a repo or folder of ours.
    .filter((n) => { try { return lstatSync(join(dir, n)).isDirectory(); } catch { return false; } })
    .sort();
}

function asRepo(path: string, name: string): { repo: string; path: string; bare: boolean } | null {
  if (name.endsWith(".git")) {
    // A bare clone is recognized by HEAD — an empty directory `x.git` is not a repo.
    return existsSync(join(path, "HEAD")) ? { repo: name.slice(0, -4), path, bare: true } : null;
  }
  return existsSync(join(path, ".git")) ? { repo: name, path, bare: false } : null;
}

/** Local git over one repo via `proc.run` (the only path to subprocesses in devd,
 *  with a hard timeout). safe.directory: devd runs as root over directories owned by
 *  uid 1000 — without it git ends with "dubious ownership" and everything would look
 *  clean (see stats.ts). */
async function git(dir: string, ...args: string[]): Promise<RunResult> {
  return run(["git", "-C", dir, "-c", `safe.directory=${dir}`, ...args], { timeoutMs: timeoutFor("LOCAL") });
}

/** Unpushed commits of one repo (workdir or bare). Never throws — a git error is
 *  returned in `error`, so one broken repo does not shoot down the whole report. */
export async function unpushedInRepo(dir: string, opts: { limit?: number } = {}): Promise<Pick<UnpushedRepo, "noRemote" | "count" | "branches" | "error">> {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  // Cheap first query: most repos are clean and end here with a single git call.
  const total = await git(dir, "rev-list", "--count", "--branches", "--not", "--remotes");
  if (total.code !== 0) return { noRemote: false, count: 0, branches: [], error: (total.stderr || total.stdout).trim() || `git failed (${total.code})` };
  if ((parseInt(total.stdout.trim(), 10) || 0) === 0) return { noRemote: false, count: 0, branches: [] };

  const remotes = await git(dir, "remote");
  const noRemote = remotes.code === 0 && remotes.stdout.trim() === "";

  const refs = await git(dir, "for-each-ref", "--sort=-committerdate", "--format=%(HEAD)%09%(refname)%09%(upstream:short)", "refs/heads");
  if (refs.code !== 0) return { noRemote, count: 0, branches: [], error: refs.stderr.trim() };
  const heads = refs.stdout.split("\n").filter(Boolean).map((l) => {
    const [head, ref, upstream] = l.split("\t");
    // Branch name from the full ref, not `%(refname:short)` — on a collision with a tag that returns
    // "heads/hotfix", and that is not the name the user knows it by.
    return { head: head === "*", ref, branch: ref.replace(/^refs\/heads\//, ""), upstream: upstream || null, hashes: [] as string[] };
  });
  for (const h of heads) {
    // Full ref, not the short name: for "hotfix" with a tag of the same name git would resolve the tag
    // (refs/tags takes precedence) and the branch would look clean. `--` separates revisions from paths.
    const list = await git(dir, "rev-list", h.ref, "--not", "--remotes", "--");
    if (list.code === 0) h.hashes = list.stdout.split("\n").filter(Boolean);
  }
  // A commit shared by several branches is reported exactly once — and goes to the BASE, i.e. the branch
  // with the fewest unpushed commits (a feature on top of an unpushed main: main has 2, feature
  // 3 → main takes its two, feature reports only its own). If HEAD went first,
  // the in-progress feature branch would also show main's commits and main would look clean.
  // Equal count → HEAD first, then by age of the last commit (the order from for-each-ref).
  heads.sort((a, b) => a.hashes.length - b.hashes.length || Number(b.head) - Number(a.head));

  const seen = new Set<string>();
  const branches: UnpushedBranch[] = [];
  for (const h of heads) {
    const fresh = h.hashes.filter((x) => !seen.has(x));
    if (!fresh.length) continue;
    for (const x of fresh) seen.add(x);
    const shown = fresh.slice(0, limit);
    // `--no-walk`: details only for the selected hashes, without walking history. `=unsorted`
    // keeps the order from rev-list (newest first).
    const details = await git(dir, "log", "--no-walk=unsorted", "--format=%H%x1f%s%x1f%ct%x1f%an", ...shown);
    const commits = details.code === 0 ? details.stdout.split("\n").filter(Boolean).map((l) => {
      const [hash, subject, ct, author] = l.split("\x1f");
      return { hash, subject, at: (parseInt(ct, 10) || 0) * 1000, author };
    }) : shown.map((hash) => ({ hash, subject: "", at: 0, author: "" }));
    branches.push({ branch: h.branch, upstream: h.upstream, count: fresh.length, commits, truncated: fresh.length > shown.length });
  }
  return { noRemote, count: seen.size, branches };
}

// ---------------------------------------------------------------- remote / base

const hostnameOf = (host: string) => host.replace(/:\d+$/, "").toLowerCase();

/** Parses the origin URL into provider + owner/name. Gitea is recognized by the host of
 *  a configured instance (without the port — git may go over ssh on a different port than
 *  the API). A pure function, tested without git. */
export function parseRemote(url: string, giteaUrls: string[]): RemoteInfo {
  const none: RemoteInfo = { provider: "other", url, host: "", owner: "", name: "" };
  let host = "";
  let path = "";
  const scp = url.match(/^(?:[^@/]+@)?([^:/]+):([^/].*)$/);          // git@host:owner/name.git
  if (scp && !url.includes("://")) {
    host = scp[1]; path = scp[2];
  } else {
    try { const u = new URL(url); host = u.host; path = u.pathname; } catch { return none; }
  }
  const parts = path.replace(/^\/+/, "").replace(/\.git$/, "").split("/").filter(Boolean);
  if (parts.length < 2 || !host) return { ...none, host };
  const [owner, name] = parts.slice(-2);
  const giteaHosts = new Set(giteaUrls.map((u) => { try { return hostnameOf(new URL(u).host); } catch { return ""; } }).filter(Boolean));
  const provider = hostnameOf(host) === "github.com" ? "github" : giteaHosts.has(hostnameOf(host)) ? "gitea" : "other";
  return { provider, url, host, owner, name };
}

/** The repo's origin; `null` = repo without a remote. */
export async function remoteInfo(dir: string, giteaUrls: string[]): Promise<RemoteInfo | null> {
  const r = await git(dir, "remote", "get-url", "origin");
  const url = r.stdout.trim();
  return r.code === 0 && url ? parseRemote(url, giteaUrls) : null;
}

/** The remote's default branch = the base for a PR. A clone of a non-empty repo has `refs/remotes/origin/HEAD`;
 *  a bare clone carries it in its own HEAD (see git.ts defaultBranch). A working clone of an EMPTY
 *  origin (a repo created via devd) has no origin/HEAD and its HEAD is simply the current
 *  branch — that MUST NOT be taken as the base (a PR of a feature branch against itself). Then a guess
 *  based on existing remote branches main/master, finally "main" as elsewhere in devd. */
export async function baseBranch(dir: string): Promise<string> {
  const remoteHead = await git(dir, "symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD");
  if (remoteHead.code === 0 && remoteHead.stdout.trim()) return remoteHead.stdout.trim().replace(/^origin\//, "");
  const bare = (await git(dir, "rev-parse", "--is-bare-repository")).stdout.trim() === "true";
  if (bare) {
    const head = await git(dir, "symbolic-ref", "-q", "--short", "HEAD");
    if (head.code === 0 && head.stdout.trim()) return head.stdout.trim();
  }
  for (const guess of ["main", "master"]) {
    if ((await git(dir, "rev-parse", "--verify", "--quiet", `refs/remotes/origin/${guess}`)).code === 0) return guess;
  }
  return "main";
}

// ---------------------------------------------------------------- push / PR

export type PushResult = { ok: true } | { ok: false; error: string };

/** `git push origin refs/heads/<b>:refs/heads/<b>` — an explicit refspec, not a bare
 *  `git push`: session branches deliberately have their upstream on the default branch (pull --rebase
 *  at session start, see sessions.ts) and a bare push would end there with "upstream branch
 *  name doesn't match". The upstream is NOT CHANGED. Git updates the remote-tracking ref itself
 *  after the push, so the commits disappear from the report. */
export async function pushBranch(dir: string, branch: string, authEnv: Record<string, string>): Promise<PushResult> {
  const ref = `refs/heads/${branch}`;
  const r = await run(["git", "-C", dir, "-c", `safe.directory=${dir}`, "push", "origin", `${ref}:${ref}`],
    { env: Object.keys(authEnv).length ? authEnv : undefined, timeoutMs: timeoutFor("GIT_NET") });
  if (r.timedOut) return { ok: false, error: `git push timed out after ${Math.round(timeoutFor("GIT_NET") / 1000)} s` };
  if (r.code !== 0) return { ok: false, error: (r.stderr || r.stdout).trim() || `git push failed (${r.code})` };
  return { ok: true };
}

type R = { code: number; stdout: string; stderr: string; timedOut?: boolean };
export type GhRunner = (cwd: string, ...cmd: string[]) => R | Promise<R>;
export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
const defaultGhRun: GhRunner = (cwd, ...cmd) => run(cmd, { cwd, timeoutMs: timeoutFor("NET_CLI") });

export interface CreatePrOpts {
  dir: string; branch: string; base: string; title: string; body: string; remote: RemoteInfo;
  /** Token of the Gitea instance (from the vault); without it a PR on Gitea cannot be created. */
  giteaToken: string | undefined;
  /** Base URL of the Gitea API instance (from the config) — origin may go over ssh on a different port. */
  giteaUrl?: string;
  ghRun?: GhRunner;
  fetcher?: Fetcher;
}

/** Creates a PR at the provider. GitHub via `gh pr create` (auth is held by `gh` on the host, same
 *  as for listing repos), Gitea via the REST API with a token. Returns the URL and number; errors
 *  (PR already exists, token rejected) are thrown with the provider's text. */
export async function createPr(o: CreatePrOpts): Promise<{ url: string; number: number | null }> {
  if (o.remote.provider === "github") {
    const runner = o.ghRun ?? defaultGhRun;
    // cwd "/": gh runs its own git in its cwd, as root and unhardened — never in the agent's repo.
    // --repo/--head/--base say everything gh would otherwise read from it.
    const r = await runner("/", "gh", "pr", "create", "--repo", `${o.remote.owner}/${o.remote.name}`, "--head", o.branch, "--base", o.base, "--title", o.title, "--body", o.body);
    if (r.timedOut) throw new Error(`gh pr create timed out after ${Math.round(timeoutFor("NET_CLI") / 1000)} s`);
    if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || "gh pr create failed");
    const url = r.stdout.trim().split("\n").map((l) => l.trim()).filter((l) => /^https?:\/\//.test(l)).pop() ?? r.stdout.trim();
    return { url, number: prNumber(url) };
  }
  if (o.remote.provider === "gitea") {
    if (!o.giteaToken) throw new Error(`Gitea ${o.remote.host}: missing token (unlock the vault / set the token in Settings)`);
    const base = (o.giteaUrl ?? `${new URL(o.remote.url).protocol}//${o.remote.host}`).replace(/\/+$/, "");
    const res = await (o.fetcher ?? fetch)(`${base}/api/v1/repos/${o.remote.owner}/${o.remote.name}/pulls`, {
      method: "POST",
      headers: { Authorization: `token ${o.giteaToken}`, "content-type": "application/json" },
      body: JSON.stringify({ head: o.branch, base: o.base, title: o.title, body: o.body }),
    });
    if (res.status === 401 || res.status === 403) throw new Error(`Gitea rejected the token (HTTP ${res.status})`);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let detail = text;
      try { detail = (JSON.parse(text) as { message?: string }).message ?? text; } catch { /* plain text */ }
      throw new Error(`Gitea PR failed (HTTP ${res.status}): ${detail.slice(0, 300)}`);
    }
    const j = (await res.json()) as { number?: number; html_url?: string };
    return { url: j.html_url ?? "", number: typeof j.number === "number" ? j.number : null };
  }
  throw new Error("A PR can only be created for a repo on GitHub or a configured Gitea instance");
}

function prNumber(url: string): number | null {
  const m = url.match(/\/(?:pull|pulls)\/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

// ---------------------------------------------------------------- PR read (prWatch.ts)

/** The branch's head on the remote as this clone last saw it (its remote-tracking ref; a push, devd's or the
 *  agent's, updates it); null = the branch was never pushed. */
export async function remoteHead(dir: string, branch: string): Promise<string | null> {
  const r = await git(dir, "rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}^{commit}`);
  if (r.code === 0) return r.stdout.trim();
  if (r.code === 1) return null; // --quiet: 1 = no such ref; anything else is git failing
  throw new Error((r.stderr || r.stdout).trim() || `git rev-parse failed (${r.code})`);
}

/** The branch checked out in `dir`; null = detached HEAD (e.g. a rebase in progress). A git failure (missing or
 *  broken worktree) throws: unlike git.ts worktreeBranch, the PR watch must tell the two apart (S5-R29). */
export async function currentBranch(dir: string): Promise<string | null> {
  const r = await git(dir, "symbolic-ref", "--quiet", "--short", "HEAD");
  if (r.code === 0 && r.stdout.trim()) return r.stdout.trim();
  if (r.code === 1) return null; // --quiet: 1 = HEAD is not a symbolic ref
  throw new Error((r.stderr || r.stdout).trim() || `git symbolic-ref failed (${r.code})`);
}

/** The repo's remote names. */
export async function remoteNames(dir: string): Promise<string[]> {
  const r = await git(dir, "remote");
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `git remote failed (${r.code})`);
  return r.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
}

/** The configured Gitea instance URL serving the remote's host (git may go over ssh on another port). */
export function giteaUrlFor(giteaUrls: string[], remote: RemoteInfo): string | undefined {
  return giteaUrls.find((u) => { try { return hostnameOf(new URL(u).host) === hostnameOf(remote.host); } catch { return false; } });
}

/** `headSha`: the PR's head commit, the one its checks belong to. */
export interface FoundPr { number: number; url: string; state: "open" | "merged" | "closed"; checks: "pending" | "success" | "failure" | "none"; headSha: string }

// GitHub check runs: any status but COMPLETED is still running; StatusContext (commit statuses) carry `state`.
// STALE (a check GitHub gave up on after 14 days) blocks nothing: neutral, as SKIPPED.
const GH_SUCCESS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED", "STALE"]);
const GH_FAILURE = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
const GH_STATUS = new Map<string, "pending" | "success" | "failure">([["SUCCESS", "success"], ["PENDING", "pending"], ["EXPECTED", "pending"], ["FAILURE", "failure"], ["ERROR", "failure"]]);

type GhCheck = { __typename?: string; status?: string; conclusion?: string; state?: string };

/** One verdict over all checks: a failure wins, then anything still running, else success; no checks = none.
 *  A value GitHub adds later is an error, not a guess. */
export function rollupChecks(rollup: GhCheck[]): FoundPr["checks"] {
  if (rollup.length === 0) return "none";
  const each = rollup.map((c): "pending" | "success" | "failure" => {
    if (c.__typename === "StatusContext") {
      const v = GH_STATUS.get(c.state ?? "");
      if (!v) throw new Error(`unknown GitHub commit status state: ${c.state}`);
      return v;
    }
    if (c.status !== "COMPLETED") return "pending";
    if (GH_SUCCESS.has(c.conclusion ?? "")) return "success";
    if (GH_FAILURE.has(c.conclusion ?? "")) return "failure";
    throw new Error(`unknown GitHub check conclusion: ${c.conclusion}`);
  });
  return each.includes("failure") ? "failure" : each.includes("pending") ? "pending" : "success";
}

// Gitea's combined commit status. `warning` does not fail a PR in Gitea (it is not an error state), so it counts as
// success here.
const GITEA_STATUS = new Map<string, "pending" | "success" | "failure">([["pending", "pending"], ["success", "success"], ["warning", "success"], ["error", "failure"], ["failure", "failure"]]);

export interface FindPrOpts {
  dir: string; branch: string; remote: RemoteInfo;
  giteaToken: string | undefined;
  giteaUrl: string | undefined;
  ghRun?: GhRunner;
  fetcher?: Fetcher;
  /** Per Gitea request, body included; default NET_CLI (the same cap `gh` runs under). */
  timeoutMs?: number;
}

/** The newest PR whose head is `branch`, with the verdict of its checks (only for an open PR: merged and closed say
 *  "none"). GitHub via `gh pr list`, Gitea via its API with the instance token. null = no PR for the branch. */
export async function findPr(o: FindPrOpts): Promise<FoundPr | null> {
  if (o.remote.provider === "github") {
    const runner = o.ghRun ?? defaultGhRun;
    // cwd "/": see createPr.
    const r = await runner("/", "gh", "pr", "list", "--repo", `${o.remote.owner}/${o.remote.name}`, "--head", o.branch,
      "--state", "all", "--limit", "1", "--json", "number,url,state,mergedAt,statusCheckRollup,headRefOid");
    if (r.timedOut) throw new Error(`gh pr list timed out after ${Math.round(timeoutFor("NET_CLI") / 1000)} s`);
    if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || "gh pr list failed");
    const list = JSON.parse(r.stdout) as { number: number; url: string; state: string; mergedAt: string | null; statusCheckRollup: GhCheck[] | null; headRefOid?: string }[];
    const pr = list[0];
    if (!pr) return null;
    if (typeof pr.headRefOid !== "string" || !pr.headRefOid) throw new Error(`gh pr list gave PR #${pr.number} without its head commit`);
    const state = pr.state === "MERGED" || pr.mergedAt ? "merged" : pr.state === "CLOSED" ? "closed" : pr.state === "OPEN" ? "open" : null;
    if (state === null) throw new Error(`unknown GitHub PR state: ${pr.state}`);
    return { number: pr.number, url: pr.url, state, checks: state === "open" ? rollupChecks(pr.statusCheckRollup ?? []) : "none", headSha: pr.headRefOid };
  }
  if (o.remote.provider === "gitea") {
    if (!o.giteaToken) throw new Error(`Gitea ${o.remote.host}: missing token (unlock the vault / set the token in Settings)`);
    if (!o.giteaUrl) throw new Error(`Gitea ${o.remote.host}: no configured instance`);
    const api = `${o.giteaUrl.replace(/\/+$/, "")}/api/v1/repos/${o.remote.owner}/${o.remote.name}`;
    const timeoutMs = o.timeoutMs ?? timeoutFor("NET_CLI");
    const get = async (url: string) => {
      const what = url.slice(api.length) || "/";
      const signal = AbortSignal.timeout(timeoutMs);
      try {
        const res = await (o.fetcher ?? fetch)(url, { headers: { Authorization: `token ${o.giteaToken}` }, signal });
        if (!res.ok) throw new Error(`Gitea ${what} failed (HTTP ${res.status})`);
        return (await res.json()) as unknown;
      } catch (e) {
        if (signal.aborted) throw new Error(`Gitea ${what} timed out after ${Math.round(timeoutMs / 1000)} s`);
        throw e;
      }
    };
    // Gitea has no head-branch filter on the list in every version; the 50 most recently updated cover a live branch.
    const pulls = (await get(`${api}/pulls?state=all&sort=recentupdate&limit=50`)) as { number: number; html_url: string; state: string; merged: boolean; head: { ref: string; sha: string } }[];
    const pr = pulls.filter((p) => p.head.ref === o.branch).sort((a, b) => b.number - a.number)[0];
    if (!pr) return null;
    const state = pr.merged ? "merged" : pr.state === "closed" ? "closed" : pr.state === "open" ? "open" : null;
    if (state === null) throw new Error(`unknown Gitea PR state: ${pr.state}`);
    if (state !== "open") return { number: pr.number, url: pr.html_url, state, checks: "none", headSha: pr.head.sha };
    const st = (await get(`${api}/commits/${pr.head.sha}/status`)) as { state: string; total_count: number };
    if (st.total_count === 0) return { number: pr.number, url: pr.html_url, state, checks: "none", headSha: pr.head.sha };
    const checks = GITEA_STATUS.get(st.state);
    if (!checks) throw new Error(`unknown Gitea commit status state: ${st.state}`);
    return { number: pr.number, url: pr.html_url, state, checks, headSha: pr.head.sha };
  }
  throw new Error("A PR can only be read for a repo on GitHub or a configured Gitea instance");
}

export interface UnpushedOpsDeps {
  /** Git auth env by origin URL (Basic auth from the Gitea token or from gh for github.com). */
  authFor: (url: string) => Record<string, string> | Promise<Record<string, string>>;
  /** Token of the Gitea instance for the origin's host. */
  giteaToken: (host: string) => string | undefined;
  /** URLs of the configured Gitea instances (provider detection + API base). */
  giteaUrls: () => string[];
  ghRun?: GhRunner;
  fetcher?: Fetcher;
}

const validBranch = (b: string) => /^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/.test(b) && !b.includes("..") && !b.endsWith("/");

/** Operations on the report for the API: push a branch and create a PR. The path MUST be one of the repos
 *  discovered under the workspace root — otherwise the route would be "run git anywhere on the host". */
export function unpushedOps(root: string, deps: UnpushedOpsDeps) {
  const repoAt = (path: string) => {
    const r = discoverRepos(root).find((x) => x.path === path);
    if (!r) throw new Error("unknown repo (path is not in the workspace)");
    return r;
  };
  const checkBranch = async (dir: string, branch: string) => {
    if (!validBranch(branch)) throw new Error(`invalid branch: ${branch.slice(0, 60)}`);
    if ((await git(dir, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`)).code !== 0) throw new Error(`branch ${branch} does not exist in the repo`);
  };
  return {
    async push(path: string, branch: string): Promise<PushResult> {
      const r = repoAt(path);
      await checkBranch(r.path, branch);
      const remote = await remoteInfo(r.path, deps.giteaUrls());
      if (!remote) return { ok: false, error: "repo has no remote — nowhere to push" };
      return pushBranch(r.path, branch, await deps.authFor(remote.url));
    },
    async createPr(p: { path: string; branch: string; title: string; body: string }): Promise<{ url: string; number: number | null }> {
      const r = repoAt(p.path);
      await checkBranch(r.path, p.branch);
      const remote = await remoteInfo(r.path, deps.giteaUrls());
      if (!remote) throw new Error("repo has no remote");
      const base = await baseBranch(r.path);
      return createPr({
        dir: r.path, branch: p.branch, base, title: p.title, body: p.body, remote,
        giteaToken: deps.giteaToken(remote.host), giteaUrl: giteaUrlFor(deps.giteaUrls(), remote), ghRun: deps.ghRun, fetcher: deps.fetcher,
      });
    },
  };
}

/** The whole report over the workspace root. Repos are scanned four at a time — more would
 *  only compete for the disk on a VPS with dozens of repos, fewer would needlessly drag out
 *  the first load. */
export async function buildUnpushedReport(root: string, opts: { limit?: number; now?: number; concurrency?: number; giteaHosts?: string[] } = {}): Promise<UnpushedReport> {
  const repos = discoverRepos(root);
  const results: UnpushedRepo[] = new Array(repos.length);
  let next = 0;
  const worker = async () => {
    while (next < repos.length) {
      const i = next++;
      const r = repos[i];
      const row: UnpushedRepo = { ...r, ...(await unpushedInRepo(r.path, { limit: opts.limit })) };
      // Remote + base only where there is something to push — the UI offers Push / Create PR accordingly.
      if (row.count > 0 && !row.error) {
        row.remote = await remoteInfo(r.path, opts.giteaHosts ?? []);
        row.base = await baseBranch(r.path);
      }
      results[i] = row;
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.concurrency ?? 4, repos.length)) }, worker));

  const byFolder = new Map<string, UnpushedFolder>();
  for (const r of results) {
    if (r.count === 0 && !r.error) continue;
    const f = byFolder.get(r.folder) ?? { folder: r.folder, count: 0, repos: [] };
    f.count += r.count;
    f.repos.push(r);
    byFolder.set(r.folder, f);
  }
  const folders = [...byFolder.values()].sort((a, b) => a.folder.localeCompare(b.folder));
  return { at: opts.now ?? Date.now(), total: folders.reduce((a, f) => a + f.count, 0), scanned: repos.length, folders };
}
