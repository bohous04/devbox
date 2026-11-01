import { expect, test } from "bun:test";
import { createGitProxy } from "../src/gitProxy";
import type { Vault } from "../src/vault";

const vault = { isLocked: () => false, unlock: () => {}, lock: () => {},
  secrets: () => ({ giteaTokens: { infra: "SKUTECNY" } }), update: () => {} } as Vault;

// A streamed body does not show up through Hono `app.request()` — it does not go over real HTTP.
// This test therefore starts a real server, because this is exactly where it shows whether
// forwarding the body works or gets stuck (git push sends the packfile as a stream).
test("a large body sent as a stream reaches the upstream in full", async () => {
  const chunk = "x".repeat(64 * 1024);
  const chunks = 32;                                  // 2 MB
  let received = 0;

  const upstream = Bun.serve({
    port: 0,
    async fetch(req) { received = (await req.arrayBuffer()).byteLength; return new Response("ok"); },
  });

  const proxy = Bun.serve({
    port: 0,
    fetch: createGitProxy({
      vault,
      instances: () => [{ name: "infra", url: `http://127.0.0.1:${upstream.port}` }],
      placeholders: () => ({ placeholder: { instance: "infra", session: "s1" } }),
    }).fetch,
  });

  const body = new ReadableStream({
    start(c) { for (let i = 0; i < chunks; i++) c.enqueue(new TextEncoder().encode(chunk)); c.close(); },
  });
  const r = await fetch(`http://127.0.0.1:${proxy.port}/git/infra/repo.git/git-receive-pack`, {
    method: "POST", body, headers: { authorization: "Basic " + btoa("devbox:placeholder") },
    duplex: "half",
  } as RequestInit);

  expect(r.status).toBe(200);
  expect(received).toBe(chunk.length * chunks);
  proxy.stop(true); upstream.stop(true);
}, 30_000);
