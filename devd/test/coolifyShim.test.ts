import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { withCoolifyCompatibility, buildSyncCommands, buildCodexSyncCommands, buildGrokSyncCommands } from "../src/claudeSetup";
const source = readFileSync(new URL("../../image/vendor/coolify-cf-shim.cjs", import.meta.url), "utf8");
function shim(env: Record<string, string>, doFetch?: (input: any, init?: any) => Promise<Response>) {
  const calls: { input: any; init: any }[] = [];
  const context = { process: { env }, URL, Headers, fetch: async (input: any, init: any) => { calls.push({ input, init }); return doFetch ? doFetch(input, init) : new Response("{}"); } };
  runInNewContext(source, context);
  return { calls, fetch: context.fetch };
}

test("legacy deploy GET becomes one POST with original UUID query even without CF", async () => {
  const s = shim({ COOLIFY_BASE_URL: "https://coolify.example.com" });
  await s.fetch("https://coolify.example.com/api/v1/deploy?uuid=app123&force=false", { method: "GET", headers: { authorization: "Bearer PRIVATE" } });
  expect(s.calls).toHaveLength(1);
  expect(s.calls[0]!.init.method).toBe("POST");
  expect(s.calls[0]!.init.redirect).toBe("error");
  expect(s.calls[0]!.input).toContain("uuid=app123&force=false");
  expect(s.calls[0]!.init.headers.get("authorization")).toBe("Bearer PRIVATE");
});

test("Request objects retain headers and target when corrected", async () => {
  const s = shim({ COOLIFY_BASE_URL: "https://coolify.example.com" });
  const request = new Request("https://coolify.example.com/api/v1/deploy?tag=site", { headers: { authorization: "Bearer PRIVATE" } });
  await s.fetch(request, undefined);
  expect(s.calls[0]!.input).toBe(request);
  expect(s.calls[0]!.init.method).toBe("POST");
  expect(s.calls[0]!.init.headers.get("authorization")).toBe("Bearer PRIVATE");
});

test("different origin and similar path are never rewritten or sent CF credentials", async () => {
  const s = shim({ COOLIFY_BASE_URL: "https://coolify.example.com", COOLIFY_CF_ACCESS_CLIENT_ID: "ID", COOLIFY_CF_ACCESS_CLIENT_SECRET: "SECRET" });
  const foreign = { method: "GET" };
  await s.fetch("https://other.example.com/api/v1/deploy?uuid=a", foreign);
  expect(s.calls[0]!.init).toBe(foreign);
  await s.fetch("https://coolify.example.com/api/v1/deployments", { method: "GET" });
  expect(s.calls[1]!.init.method).toBe("GET");
  expect(s.calls[1]!.init.headers.get("CF-Access-Client-Secret")).toBe("SECRET");
  expect(s.calls[1]!.init.redirect).toBe("error");
});

test("new POST stays POST and preserves JSON body, no duplicate call", async () => {
  const s = shim({ COOLIFY_BASE_URL: "https://coolify.example.com" });
  const init = { method: "POST", body: JSON.stringify({ uuid: "a" }) };
  await s.fetch("https://coolify.example.com/api/v1/deploy", init);
  expect(s.calls).toHaveLength(1);
  expect(s.calls[0]!.init).toMatchObject({ ...init, redirect: "error" });
});

test("real HTTP redirects cannot forward CF credentials or replay deployment triggers", async () => {
  let received = 0, attempted = 0;
  const destination = createServer((_request, response) => { received++; response.end("{}"); });
  destination.listen(0, "127.0.0.1");
  await once(destination, "listening");
  const origin = createServer((_request, response) => {
    attempted++;
    response.writeHead(307, { location: `http://127.0.0.1:${(destination.address() as AddressInfo).port}/capture` });
    response.end();
  });
  origin.listen(0, "127.0.0.1");
  await once(origin, "listening");
  try {
    const base = `http://127.0.0.1:${(origin.address() as AddressInfo).port}`;
    const cf = shim({ COOLIFY_BASE_URL: base, COOLIFY_CF_ACCESS_CLIENT_ID: "test-id", COOLIFY_CF_ACCESS_CLIENT_SECRET: "test-secret" }, fetch);
    await expect(cf.fetch(`${base}/api/v1/databases`, { redirect: "follow" })).rejects.toThrow();
    const noCf = shim({ COOLIFY_BASE_URL: base }, fetch);
    for (const method of ["GET", "POST"]) {
      await expect(noCf.fetch(`${base}/api/v1/deploy?uuid=isolated`, { method, redirect: "follow" })).rejects.toThrow();
    }
    expect(attempted).toBe(3);
    expect(received).toBe(0);
  } finally {
    origin.closeAllConnections(); destination.closeAllConnections();
    await Promise.all([
      new Promise<void>((resolve) => origin.close(() => resolve())),
      new Promise<void>((resolve) => destination.close(() => resolve())),
    ]);
  }
});

test("missing or invalid configured base makes shim transparent", async () => {
  const s = shim({ COOLIFY_CF_ACCESS_CLIENT_ID: "ID", COOLIFY_CF_ACCESS_CLIENT_SECRET: "SECRET" });
  const init = { method: "GET" };
  await s.fetch("https://coolify.example.com/api/v1/deploy", init);
  expect(s.calls[0]!.init).toBe(init);
});

test("MCP sync enables compatibility once while preserving other node flags", () => {
  const defs = { "acme-coolify": { command: "npx", args: ["@masonator/coolify-mcp@2.12.0"], env: { COOLIFY_BASE_URL: "https://coolify.example.com", NODE_OPTIONS: "--max-old-space-size=2048" } }, other: { command: "npx", env: { OTHER: "value" } } };
  const once = withCoolifyCompatibility(defs);
  expect((once["acme-coolify"] as any).env.NODE_OPTIONS).toBe("--max-old-space-size=2048 --require /opt/coolify-cf-shim.cjs");
  expect(withCoolifyCompatibility(once)).toEqual(once);
  expect(once.other).toBe(defs.other);
  expect(defs["acme-coolify"].env.NODE_OPTIONS).toBe("--max-old-space-size=2048");
  const setup = { marketplaces: [], plugins: [] };
  for (const result of [buildSyncCommands(setup, defs), buildCodexSyncCommands(setup, defs).cmds, buildGrokSyncCommands(setup, defs).cmds]) {
    expect(JSON.stringify(result)).toContain("/opt/coolify-cf-shim.cjs");
  }
});
