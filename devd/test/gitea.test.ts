import { expect, test } from "bun:test";
import {
  createGiteaApi, GiteaAuthError, GiteaError, GiteaUnknownInstanceError, listGiteaRepos, verifyGiteaToken, type Fetcher,
} from "../src/gitea";

/** Fetch stub keyed by URL; records the URL + headers of every call. */
function fetchStub(routes: Record<string, { status: number; body?: unknown }>): {
  fetcher: Fetcher; calls: { url: string; headers: Record<string, string> }[];
} {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetcher: Fetcher = async (url, init) => {
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const hit = routes[url];
    if (!hit) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(hit.body ?? {}), {
      status: hit.status, headers: { "content-type": "application/json" },
    });
  };
  return { fetcher, calls };
}

const INST = { name: "Portal", url: "http://198.51.100.7:3000/" }; // trailing slash on purpose
const SEARCH1 = "http://198.51.100.7:3000/api/v1/repos/search?limit=50&page=1";
const SEARCH2 = "http://198.51.100.7:3000/api/v1/repos/search?limit=50&page=2";
const USER = "http://198.51.100.7:3000/api/v1/user";

const rawRepo = (name: string, owner = "bob") => ({
  name, full_name: `${owner}/${name}`, owner: { login: owner },
  description: null, private: true, archived: false,
  updated_at: "2026-07-01T10:00:00Z", clone_url: `http://g/${owner}/${name}.git`,
});

test("listGiteaRepos maps and normalizes search results + sends the token", async () => {
  const { fetcher, calls } = fetchStub({
    [SEARCH1]: { status: 200, body: { ok: true, data: [rawRepo("rp"), { junk: true }] } },
  });
  const out = await listGiteaRepos(INST, "secret", fetcher);
  expect(out).toEqual([{
    name: "rp", fullName: "bob/rp", owner: "bob", description: "",
    isPrivate: true, isArchived: false, updatedAt: "2026-07-01T10:00:00Z",
    cloneUrl: "http://g/bob/rp.git",
  }]);
  expect(calls[0].headers).toEqual({ Authorization: "token secret" });
});

test("listGiteaRepos without a token does not send Authorization", async () => {
  const { fetcher, calls } = fetchStub({ [SEARCH1]: { status: 200, body: { data: [] } } });
  await listGiteaRepos(INST, undefined, fetcher);
  expect(calls[0].headers).toEqual({});
});

test("listGiteaRepos paginates while full pages keep coming", async () => {
  const page1 = Array.from({ length: 50 }, (_, i) => rawRepo(`r${i}`));
  const { fetcher, calls } = fetchStub({
    [SEARCH1]: { status: 200, body: { data: page1 } },
    [SEARCH2]: { status: 200, body: { data: [rawRepo("last")] } },
  });
  const out = await listGiteaRepos(INST, "t", fetcher);
  expect(out).toHaveLength(51);
  expect(calls.map((c) => c.url)).toEqual([SEARCH1, SEARCH2]);
});

test("listGiteaRepos non-2xx → GiteaError with the status", async () => {
  const { fetcher } = fetchStub({ [SEARCH1]: { status: 500 } });
  await expect(listGiteaRepos(INST, "t", fetcher)).rejects.toThrow(GiteaError);
  await expect(listGiteaRepos(INST, "t", fetcher)).rejects.toThrow("HTTP 500");
});

test("listGiteaRepos network error -> GiteaError unreachable", async () => {
  const fetcher: Fetcher = async () => { throw new Error("connect ECONNREFUSED"); };
  await expect(listGiteaRepos(INST, "t", fetcher)).rejects.toThrow(/unreachable/);
});

test("verifyGiteaToken returns the login; 401 → GiteaAuthError; network → GiteaError", async () => {
  const ok = fetchStub({ [USER]: { status: 200, body: { login: "alice" } } });
  expect(await verifyGiteaToken(INST, "t", ok.fetcher)).toEqual({ login: "alice" });
  expect(ok.calls[0].headers).toEqual({ Authorization: "token t" });

  const denied = fetchStub({ [USER]: { status: 401, body: { message: "unauthorized" } } });
  await expect(verifyGiteaToken(INST, "bad", denied.fetcher)).rejects.toThrow(GiteaAuthError);

  const down: Fetcher = async () => { throw new Error("timeout"); };
  await expect(verifyGiteaToken(INST, "t", down)).rejects.toThrow(GiteaError);
});

test("createGiteaApi.instances maps hasToken and does not leak the token", () => {
  const api = createGiteaApi({
    getInstances: () => [{ name: "Portal", url: "http://g" }, { name: "b", url: "http://b" }],
    tokens: { Portal: "secret" },
    persist: () => {},
  });
  expect(api.instances()).toEqual([
    { name: "Portal", url: "http://g", hasToken: true },
    { name: "b", url: "http://b", hasToken: false },
  ]);
});

test("createGiteaApi.repos: unknown instance → GiteaUnknownInstanceError", async () => {
  const api = createGiteaApi({ getInstances: () => [], tokens: {}, persist: () => {} });
  await expect(api.repos("typo")).rejects.toThrow(GiteaUnknownInstanceError);
});

test("createGiteaApi.setToken verifies, stores into the shared object and persists", async () => {
  const tokens: Record<string, string> = {};
  const persisted: Record<string, string>[] = [];
  const { fetcher } = fetchStub({ ["http://g/api/v1/user"]: { status: 200, body: { login: "alice" } } });
  const api = createGiteaApi({
    getInstances: () => [{ name: "Portal", url: "http://g" }],
    tokens, persist: (t) => persisted.push({ ...t }), fetcher,
  });
  expect(await api.setToken("Portal", "new")).toEqual({ login: "alice" });
  expect(tokens).toEqual({ Portal: "new" });
  expect(persisted).toEqual([{ Portal: "new" }]);
});

test("createGiteaApi.setToken: a rejected token stores nothing", async () => {
  const tokens: Record<string, string> = {};
  const persisted: unknown[] = [];
  const { fetcher } = fetchStub({ ["http://g/api/v1/user"]: { status: 401 } });
  const api = createGiteaApi({
    getInstances: () => [{ name: "Portal", url: "http://g" }],
    tokens, persist: (t) => persisted.push(t), fetcher,
  });
  await expect(api.setToken("Portal", "wrong")).rejects.toThrow(GiteaAuthError);
  expect(tokens).toEqual({});
  expect(persisted).toEqual([]);
});
