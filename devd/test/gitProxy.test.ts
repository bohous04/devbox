import { expect, test } from "bun:test";
import { createGitProxy, type GitProxyDeps } from "../src/gitProxy";
import type { Secrets } from "../src/config";
import { VaultLocked, type Vault } from "../src/vault";

function openVaultWith(secrets: Secrets): Vault {
  return { isLocked: () => false, unlock: () => {}, lock: () => {}, secrets: () => secrets, update: () => {} };
}
const lockedVault: Vault = {
  isLocked: () => true, unlock: () => {}, lock: () => {},
  secrets: () => { throw new VaultLocked(); },
  update: () => { throw new VaultLocked(); },
};

function deps(over: Partial<GitProxyDeps> = {}): GitProxyDeps {
  return {
    vault: openVaultWith({ giteaTokens: { infra: "REAL_TOKEN" } }),
    instances: () => [{ name: "infra", url: "https://git.example.com" }],
    placeholders: () => ({ "devbox-sess1-aaa": { instance: "infra", session: "sess1" } }),
    fetch: async () => new Response("ok"),
    ...over,
  };
}

const basic = (pw: string) => ({ headers: { authorization: "Basic " + btoa(`devbox:${pw}`) } });

test("swaps the placeholder for the real token and forwards to the upstream", async () => {
  let seenAuth = "", seenUrl = "";
  const app = createGitProxy(deps({
    fetch: async (req) => { seenAuth = req.headers.get("authorization") ?? ""; seenUrl = req.url; return new Response("ok"); },
  }));
  const r = await app.request("/git/infra/repo.git/info/refs?service=git-upload-pack", basic("devbox-sess1-aaa"));
  expect(r.status).toBe(200);
  expect(atob(seenAuth.replace("Basic ", ""))).toBe("devbox:REAL_TOKEN");
  expect(seenUrl).toBe("https://git.example.com/repo.git/info/refs?service=git-upload-pack");
});

test("an unknown placeholder is rejected and NOT forwarded", async () => {
  let called = false;
  const app = createGitProxy(deps({ fetch: async () => { called = true; return new Response("ok"); } }));
  const r = await app.request("/git/infra/repo.git/info/refs", basic("foreign-placeholder"));
  expect(r.status).toBe(403);
  expect(called).toBe(false);
});

test("a session placeholder is valid on another instance too, the token is taken by path", async () => {
  // The credential helper in the container keys by host and all instances go through
  // devd, so a session has a single placeholder (issued on the first instance). Previously a push to
  // the second Gitea failed with 403.
  let seenAuth = "", seenUrl = "";
  const app = createGitProxy(deps({
    vault: openVaultWith({ giteaTokens: { infra: "REAL_TOKEN", jina: "JINY_TOKEN" } }),
    instances: () => [{ name: "infra", url: "https://git.example.com" }, { name: "jina", url: "https://jina.example.com" }],
    fetch: async (req) => { seenAuth = req.headers.get("authorization") ?? ""; seenUrl = req.url; return new Response("ok"); },
  }));
  const r = await app.request("/git/jina/repo.git/info/refs", basic("devbox-sess1-aaa"));
  expect(r.status).toBe(200);
  expect(atob(seenAuth.replace("Basic ", ""))).toBe("devbox:JINY_TOKEN");
  expect(seenUrl).toBe("https://jina.example.com/repo.git/info/refs");
});

test("a locked vault returns 423 and forwards nothing", async () => {
  let called = false;
  const app = createGitProxy(deps({ vault: lockedVault, fetch: async () => { called = true; return new Response("ok"); } }));
  const r = await app.request("/git/infra/repo.git/info/refs", basic("devbox-sess1-aaa"));
  expect(r.status).toBe(423);
  expect(called).toBe(false);
});

test("a token missing from the vault is 502, not a silent pass-through without auth", async () => {
  let called = false;
  const app = createGitProxy(deps({
    vault: openVaultWith({ giteaTokens: {} }),
    fetch: async () => { called = true; return new Response("ok"); },
  }));
  const r = await app.request("/git/infra/repo.git/info/refs", basic("devbox-sess1-aaa"));
  expect(r.status).toBe(502);
  expect(called).toBe(false);
});

test("an unknown instance is 404", async () => {
  const app = createGitProxy(deps());
  expect((await app.request("/git/unknown/repo.git/info/refs", basic("devbox-sess1-aaa"))).status).toBe(404);
});

test("audit gets the session and path but not the token", async () => {
  const seen: { session: string; instance: string; path: string }[] = [];
  const app = createGitProxy(deps({ audit: (e) => seen.push(e) }));
  await app.request("/git/infra/repo.git/info/refs", basic("devbox-sess1-aaa"));
  expect(seen).toEqual([{ session: "sess1", instance: "infra", path: "/repo.git/info/refs" }]);
  expect(JSON.stringify(seen)).not.toContain("REAL_TOKEN");
});

test("without auth returns 401 with a challenge — otherwise git never calls the credential helper", async () => {
  let called = false;
  const app = createGitProxy(deps({ fetch: async () => { called = true; return new Response("ok"); } }));
  const r = await app.request("/git/infra/repo.git/info/refs");
  expect(r.status).toBe(401);
  expect(r.headers.get("WWW-Authenticate")).toContain("Basic");
  expect(called).toBe(false);
});

test("the POST body reaches the upstream unchanged", async () => {
  let seen = "";
  const app = createGitProxy(deps({
    fetch: async (req) => { seen = await req.text(); return new Response("ok"); },
  }));
  const r = await app.request("/git/infra/repo.git/git-upload-pack", {
    method: "POST", body: "0032want abc123\n0000", ...basic("devbox-sess1-aaa"),
  });
  expect(r.status).toBe(200);
  expect(seen).toBe("0032want abc123\n0000");
});
