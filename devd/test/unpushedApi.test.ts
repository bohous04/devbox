import { expect, test } from "bun:test";
import { createApp } from "../src/api";
import type { UnpushedReport } from "../src/unpushed";
import { fakeDeps } from "./helpers/apiHarness";

const REPORT: UnpushedReport = {
  at: 1000, total: 2, scanned: 5,
  folders: [{ folder: "apps", count: 2, repos: [{
    folder: "apps", project: "apps", repo: "web", path: "/srv/dev/apps/web", bare: false, noRemote: false, count: 2,
    branches: [{ branch: "main", upstream: "origin/main", count: 2, truncated: false, commits: [
      { hash: "a".repeat(40), subject: "wip 2", at: 2000, author: "t" },
      { hash: "b".repeat(40), subject: "wip 1", at: 1000, author: "t" },
    ] }],
  }] }],
};

function fakeCache() {
  let gets = 0, invalidates = 0;
  return {
    calls: () => ({ gets, invalidates }),
    dep: { get: async () => { gets++; return REPORT; }, invalidate: () => { invalidates++; } },
  };
}

test("GET /api/unpushed returns the report from the cache", async () => {
  const cache = fakeCache();
  const app = createApp(fakeDeps({ unpushed: cache.dep }));
  const r = await app.request("/api/unpushed");
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual(REPORT);
  expect(cache.calls()).toEqual({ gets: 1, invalidates: 0 });
});

test("GET /api/unpushed?fresh=1 first drops the cache, then reads", async () => {
  const cache = fakeCache();
  const app = createApp(fakeDeps({ unpushed: cache.dep }));
  const r = await app.request("/api/unpushed?fresh=1");
  expect(r.status).toBe(200);
  expect(cache.calls()).toEqual({ gets: 1, invalidates: 1 });
});

test("without a wired scan it answers 503, not 500 or an empty report", async () => {
  const app = createApp(fakeDeps());
  const r = await app.request("/api/unpushed");
  expect(r.status).toBe(503);
});

// ---------------------------------------------------------------- push / PR

const post = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

function opsDeps(over: { push?: (path: string, branch: string) => Promise<{ ok: true } | { ok: false; error: string }>; createPr?: (p: { path: string; branch: string; title: string; body: string }) => Promise<{ url: string; number: number | null }> } = {}) {
  const calls: unknown[] = [];
  const cache = fakeCache();
  const dep = {
    ...cache.dep,
    push: over.push ?? (async (path: string, branch: string) => { calls.push(["push", path, branch]); return { ok: true as const }; }),
    createPr: over.createPr ?? (async (p: { path: string; branch: string; title: string; body: string }) => { calls.push(["pr", p]); return { url: "https://github.com/o/n/pull/5", number: 5 }; }),
  };
  return { calls, cache, dep };
}

test("POST /api/unpushed/push pushes the branch and drops the cache", async () => {
  const { calls, cache, dep } = opsDeps();
  const app = createApp(fakeDeps({ unpushed: dep }));
  const r = await app.request("/api/unpushed/push", post({ path: "/srv/dev/apps/web", branch: "feature" }));
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ ok: true });
  expect(calls).toEqual([["push", "/srv/dev/apps/web", "feature"]]);
  expect(cache.calls().invalidates).toBe(1);
});

test("POST /api/unpushed/push: git error = 502 with text, missing field = 400", async () => {
  const { dep } = opsDeps({ push: async () => ({ ok: false, error: "rejected: non-fast-forward" }) });
  const app = createApp(fakeDeps({ unpushed: dep }));
  const bad = await app.request("/api/unpushed/push", post({ path: "/srv/dev/apps/web", branch: "feature" }));
  expect(bad.status).toBe(502);
  expect(((await bad.json()) as { error: string }).error).toContain("non-fast-forward");
  expect((await app.request("/api/unpushed/push", post({ path: "/srv/dev/apps/web" }))).status).toBe(400);
});

test("POST /api/unpushed/push: rejection from ops (foreign path) = 400 with a message", async () => {
  const { dep } = opsDeps({ push: async () => { throw new Error("unknown repo"); } });
  const app = createApp(fakeDeps({ unpushed: dep }));
  const r = await app.request("/api/unpushed/push", post({ path: "/etc", branch: "main" }));
  expect(r.status).toBe(400);
  expect(((await r.json()) as { error: string }).error).toBe("unknown repo");
});

test("POST /api/unpushed/pr pushes first, then creates the PR and returns the URL", async () => {
  const { calls, cache, dep } = opsDeps();
  const app = createApp(fakeDeps({ unpushed: dep }));
  const r = await app.request("/api/unpushed/pr", post({ path: "/srv/dev/apps/web", branch: "feature", title: "Title", body: "- work" }));
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ url: "https://github.com/o/n/pull/5", number: 5 });
  expect(calls).toEqual([
    ["push", "/srv/dev/apps/web", "feature"],
    ["pr", { path: "/srv/dev/apps/web", branch: "feature", title: "Title", body: "- work" }],
  ]);
  expect(cache.calls().invalidates).toBe(1);
});

test("POST /api/unpushed/pr: when the push fails, no PR is created; provider error = 502", async () => {
  const pushFail = opsDeps({ push: async () => ({ ok: false, error: "auth failed" }) });
  let app = createApp(fakeDeps({ unpushed: pushFail.dep }));
  const r1 = await app.request("/api/unpushed/pr", post({ path: "/srv/dev/apps/web", branch: "f", title: "T" }));
  expect(r1.status).toBe(502);
  expect(pushFail.calls.filter((c) => (c as unknown[])[0] === "pr")).toEqual([]);

  const prFail = opsDeps({ createPr: async () => { throw new Error("a pull request already exists"); } });
  app = createApp(fakeDeps({ unpushed: prFail.dep }));
  const r2 = await app.request("/api/unpushed/pr", post({ path: "/srv/dev/apps/web", branch: "f", title: "T" }));
  expect(r2.status).toBe(502);
  expect(((await r2.json()) as { error: string }).error).toContain("already exists");
  // An empty title = 400 even before the push.
  expect((await app.request("/api/unpushed/pr", post({ path: "/srv/dev/apps/web", branch: "f", title: "  " }))).status).toBe(400);
});
