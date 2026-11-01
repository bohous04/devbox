/**
 * Gitea API for the visual config editor: listing repos via /repos/search
 * (everything the token can see — including other users' repos) and token verification.
 * Injectable fetcher so tests never hit the network (pattern of github.ts Runner).
 */

export interface GiteaInstance { name: string; url: string }
export interface GiteaRepoRow {
  name: string; fullName: string; owner: string; description: string;
  isPrivate: boolean; isArchived: boolean; updatedAt: string; cloneUrl: string;
}

export class GiteaError extends Error {}
export class GiteaAuthError extends GiteaError {}
export class GiteaUnknownInstanceError extends GiteaError {}

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

const PAGE_LIMIT = 50;
const MAX_PAGES = 10; // cap of 500 repos — self-hosted instance, more makes no sense

const base = (url: string): string => url.replace(/\/+$/, "");

async function giteaFetch(inst: GiteaInstance, path: string, token: string | undefined, fetcher: Fetcher): Promise<Response> {
  let res: Response;
  try {
    res = await fetcher(`${base(inst.url)}${path}`, {
      headers: token ? { Authorization: `token ${token}` } : {},
    });
  } catch (e) {
    throw new GiteaError(`Gitea ${inst.name} unreachable: ${(e as Error).message}`);
  }
  return res;
}

export async function listGiteaRepos(inst: GiteaInstance, token: string | undefined, fetcher: Fetcher = fetch): Promise<GiteaRepoRow[]> {
  const out: GiteaRepoRow[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await giteaFetch(inst, `/api/v1/repos/search?limit=${PAGE_LIMIT}&page=${page}`, token, fetcher);
    if (!res.ok) throw new GiteaError(`Gitea ${inst.name}: HTTP ${res.status}`);
    const body = (await res.json()) as { data?: unknown };
    const rows = Array.isArray(body.data) ? body.data : [];
    for (const raw of rows) {
      const v = (raw ?? {}) as Record<string, unknown>;
      const owner = ((v.owner ?? {}) as Record<string, unknown>).login;
      out.push({
        name: typeof v.name === "string" ? v.name : "",
        fullName: typeof v.full_name === "string" ? v.full_name : "",
        owner: typeof owner === "string" ? owner : "",
        description: typeof v.description === "string" ? v.description : "",
        isPrivate: Boolean(v.private),
        isArchived: Boolean(v.archived),
        updatedAt: typeof v.updated_at === "string" ? v.updated_at : "",
        cloneUrl: typeof v.clone_url === "string" ? v.clone_url : "",
      });
    }
    if (rows.length < PAGE_LIMIT) break;
  }
  return out.filter((r) => r.name !== "");
}

export async function verifyGiteaToken(inst: GiteaInstance, token: string, fetcher: Fetcher = fetch): Promise<{ login: string }> {
  const res = await giteaFetch(inst, "/api/v1/user", token, fetcher);
  if (res.status === 401 || res.status === 403) throw new GiteaAuthError("Gitea rejected the token");
  if (!res.ok) throw new GiteaError(`Gitea ${inst.name}: HTTP ${res.status}`);
  const body = (await res.json()) as { login?: unknown };
  if (typeof body.login !== "string" || !body.login) throw new GiteaError("Gitea /user: missing login");
  return { login: body.login };
}

/** Facade for the /api/gitea/* endpoints: instances fresh from the getter (config on disk),
 * tokens from a shared mutated object, persist calls the secrets write + materialization. */
export interface GiteaApi {
  instances(): { name: string; url: string; hasToken: boolean }[];
  repos(instance: string): Promise<GiteaRepoRow[]>;
  setToken(instance: string, token: string): Promise<{ login: string }>;
}

export function createGiteaApi(d: {
  getInstances: () => GiteaInstance[];
  tokens: Record<string, string>;
  persist: (tokens: Record<string, string>) => void;
  fetcher?: Fetcher;
}): GiteaApi {
  const fetcher = d.fetcher ?? fetch;
  const find = (name: string): GiteaInstance => {
    const inst = d.getInstances().find((i) => i.name === name);
    if (!inst) throw new GiteaUnknownInstanceError(`Unknown Gitea instance: ${name}`);
    return inst;
  };
  return {
    instances: () => d.getInstances().map((i) => ({ name: i.name, url: i.url, hasToken: Boolean(d.tokens[i.name]) })),
    async repos(instance) {
      return listGiteaRepos(find(instance), d.tokens[instance], fetcher);
    },
    async setToken(instance, token) {
      const who = await verifyGiteaToken(find(instance), token, fetcher);
      d.tokens[instance] = token;
      d.persist(d.tokens);
      return who;
    },
  };
}
