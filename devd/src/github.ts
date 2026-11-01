import { run as runProc, timeoutFor } from "./proc";

type R = { code: number; stdout: string; stderr: string; timedOut?: boolean };
/** Injectable command runner so tests never shell out to a real `gh`. `timedOut`
 *  is optional so that old fakes in tests (without that field) stay valid. */
export type Runner = (cwd: string, ...cmd: string[]) => R | Promise<R>;
const defaultRun: Runner = (cwd, ...cmd) => runProc(cmd, { cwd, timeoutMs: timeoutFor("NET_CLI") });

export interface GithubOwner { login: string; kind: "user" | "org"; name?: string; avatarUrl?: string }
export interface GithubRepo {
  name: string;
  nameWithOwner: string;
  url: string;
  visibility: string;
  description: string;
  isPrivate: boolean;
  isArchived: boolean;
  updatedAt: string;
}

export class GithubError extends Error {}

/** GitHub logins/org slugs: alphanumeric, dash, underscore, dot. Whitelisted before shelling out. */
export const validOwner = (s: string): boolean => /^[A-Za-z0-9._-]{1,100}$/.test(s);

function fail(what: string, r: R): never {
  // The `run()` (proc.ts) timeout does not throw, it just returns `timedOut: true` with an
  // empty stderr — without this branch it would end with a confusing "gh exited
  // with an error" message without a single hint that it was a timeout, not a `gh` error.
  if (r.timedOut) throw new GithubError(`${what} timed out after ${Math.round(timeoutFor("NET_CLI") / 1000)} s`);
  const detail = r.stderr.trim().split("\n").find((l) => l.trim()) ?? "";
  throw new GithubError(`${what} failed: ${detail || "gh exited with an error"}`);
}

/** Authenticated account first, then its orgs. Shells out to `gh` like tree.ghLister. */
export async function listOwners(run: Runner = defaultRun): Promise<GithubOwner[]> {
  const u = await run(process.cwd(), "gh", "api", "user", "--jq", "{login,name,avatar_url}");
  if (u.code !== 0) fail("gh api user", u);
  let me: { login?: unknown; name?: unknown; avatar_url?: unknown };
  try { me = JSON.parse(u.stdout) as typeof me; } catch { throw new GithubError("gh api user returned invalid JSON"); }
  if (typeof me.login !== "string" || !me.login) throw new GithubError("gh api user: missing login");
  const owners: GithubOwner[] = [{
    login: me.login,
    kind: "user",
    ...(typeof me.name === "string" && me.name ? { name: me.name } : {}),
    ...(typeof me.avatar_url === "string" && me.avatar_url ? { avatarUrl: me.avatar_url } : {}),
  }];

  const o = await run(process.cwd(), "gh", "api", "user/orgs", "--paginate", "--jq", ".[]|{login,avatar_url}");
  if (o.code !== 0) fail("gh api user/orgs", o);
  for (const line of o.stdout.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let org: { login?: unknown; avatar_url?: unknown };
    try { org = JSON.parse(t) as typeof org; } catch { continue; }
    if (typeof org.login !== "string" || !org.login) continue;
    owners.push({
      login: org.login,
      kind: "org",
      ...(typeof org.avatar_url === "string" && org.avatar_url ? { avatarUrl: org.avatar_url } : {}),
    });
  }
  return owners;
}

/** All repos of one owner via `gh repo list` (same tool the tree lister uses). */
export async function listRepos(owner: string, run: Runner = defaultRun): Promise<GithubRepo[]> {
  if (!validOwner(owner)) throw new GithubError(`invalid owner: ${owner}`);
  const fields = "name,nameWithOwner,url,visibility,description,isPrivate,isArchived,updatedAt";
  const r = await run(process.cwd(), "gh", "repo", "list", owner, "--limit", "300", "--json", fields);
  if (r.code !== 0) fail(`gh repo list ${owner}`, r);
  let rows: unknown;
  try { rows = JSON.parse(r.stdout); } catch { throw new GithubError("gh repo list returned invalid JSON"); }
  if (!Array.isArray(rows)) throw new GithubError("gh repo list: unexpected response shape");
  return rows
    .map((x) => {
      const v = (x ?? {}) as Record<string, unknown>;
      return {
        name: typeof v.name === "string" ? v.name : "",
        nameWithOwner: typeof v.nameWithOwner === "string" ? v.nameWithOwner : "",
        url: typeof v.url === "string" ? v.url : "",
        visibility: typeof v.visibility === "string" ? v.visibility.toLowerCase() : "",
        description: typeof v.description === "string" ? v.description : "",
        isPrivate: Boolean(v.isPrivate),
        isArchived: Boolean(v.isArchived),
        updatedAt: typeof v.updatedAt === "string" ? v.updatedAt : "",
      };
    })
    .filter((x) => x.name !== "");
}
