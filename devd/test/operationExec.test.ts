import { expect, test } from "bun:test";
import { createOperationExec, prepareCoolifyDeployment, safeOperationError } from "../src/operationExec";
import { setRestartProjects } from "../src/operations";

setRestartProjects(["shop"]);

const coolify = { url: "https://coolify.example.com", token: "SECRET_TOKEN", apps: { shop: "uuid-shop" } };
const sha = "e0c38dcb85f37828e380ce6891a52568a9893ede";
function fixture() {
  let commit = "HEAD";
  const requests: Request[] = [];
  const fetch = async (req: Request) => {
    requests.push(req.clone() as unknown as Request);
    const path = new URL(req.url).pathname;
    if (path === "/api/v1/applications/uuid-shop") {
      if (req.method === "PATCH") commit = (await req.json() as { git_commit_sha: string }).git_commit_sha;
      return Response.json({ uuid: "uuid-shop", git_commit_sha: commit });
    }
    if (path === "/api/v1/deploy") return Response.json({ deployments: [{ resource_uuid: "uuid-shop", deployment_uuid: "deployment123" }] });
    if (path === "/api/v1/deployments/deployment123") return Response.json({ commit });
    if (path === "/api/v1/applications/uuid-shop/restart") return Response.json({ deployment_uuid: "restart123" });
    throw new Error(`Unexpected request ${req.method} ${path}`);
  };
  return { requests, fetch, coolify: () => coolify };
}

test("deploy uses POST JSON on exact mapped application and returns deployment ID", async () => {
  const f = fixture();
  const note = await createOperationExec(f)("deploy", { project: " shop " });
  const post = f.requests.find((r) => r.method === "POST")!;
  expect(post.url).toBe("https://coolify.example.com/api/v1/deploy");
  expect(await post.json()).toEqual({ uuid: "uuid-shop" });
  expect(post.headers.get("authorization")).toBe("Bearer SECRET_TOKEN");
  expect(note).toContain("deployment=deployment123");
  expect(note).not.toContain("SECRET_TOKEN");
});

test("missing vault and unknown projects fail before requests", async () => {
  await expect(createOperationExec({ coolify: () => undefined })("deploy", { project: "shop" })).rejects.toThrow(/vault/);
  const f = fixture();
  await expect(createOperationExec(f)("deploy", { project: "metro" })).rejects.toThrow(/metro/);
  expect(f.requests).toHaveLength(0);
});

test("unknown operation and mismatched application fail closed", async () => {
  const f = fixture(), exec = createOperationExec(f);
  await expect(exec("other", {})).rejects.toThrow(/implementation/);
  await expect(exec("deploy", { project: "shop", application: "unapproved" })).rejects.toThrow(/does not match/);
  expect(f.requests).toHaveLength(0);
});

test("Coolify failure preserves status without upstream credentials", async () => {
  const exec = createOperationExec({ coolify: () => coolify, fetch: async () => new Response("SECRET_TOKEN", { status: 500 }) });
  await expect(exec("deploy", { project: "shop" })).rejects.toThrow(/500/);
  try { await exec("deploy", { project: "shop" }); } catch (e) { expect(String(e)).not.toContain("SECRET_TOKEN"); }
});

test("read-only preparation reveals persistent pin change and immutable target", async () => {
  const f = fixture();
  const plan = await prepareCoolifyDeployment(f, { project: " shop ", commit: ` ${sha} ` });
  expect(plan).toMatchObject({ project: "shop", application: "uuid-shop", commit: sha, previousCommit: "HEAD" });
  expect(plan.changes.join("\n")).toContain("pin stays in place");
  expect(f.requests.map((r) => r.method)).toEqual(["GET"]);
});

test("approved exact SHA is pinned, verified, queued by POST and verified in queue", async () => {
  const f = fixture();
  const result = await createOperationExec(f)("deploy", { project: "shop", application: "uuid-shop", commit: sha, previousCommit: "HEAD" });
  expect(f.requests.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual([
    "GET /api/v1/applications/uuid-shop", "PATCH /api/v1/applications/uuid-shop", "GET /api/v1/applications/uuid-shop", "POST /api/v1/deploy", "GET /api/v1/deployments/deployment123",
  ]);
  expect(await f.requests[1]!.json()).toEqual({ git_commit_sha: sha });
  expect(result).toContain(`commit=${sha}`);
});

test("commit without prepared previous state and short SHA are never ignored", async () => {
  const f = fixture(), exec = createOperationExec(f);
  await expect(exec("deploy", { project: "shop", commit: sha })).rejects.toThrow(/prepared/);
  await expect(exec("deploy", { project: "shop", commit: "e0c38dc", previousCommit: "HEAD" })).rejects.toThrow(/full Git/);
  expect(f.requests).toHaveLength(0);
});

test("configuration drift requires a new approval; already completed pin resumes safely", async () => {
  const f = fixture(), exec = createOperationExec(f);
  await exec("deploy", { project: "shop", commit: sha, previousCommit: "HEAD" });
  await exec("deploy", { project: "shop", commit: sha, previousCommit: "HEAD" });
  expect(f.requests.filter((r) => r.method === "PATCH")).toHaveLength(1);
  await expect(exec("deploy", { project: "shop", commit: "a".repeat(40), previousCommit: "HEAD" })).rejects.toThrow(/changed since approval/);
});

test("concurrent conflicting approvals cannot race through the same app pin", async () => {
  const f = fixture(), exec = createOperationExec(f);
  const results = await Promise.allSettled([
    exec("deploy", { project: "shop", commit: sha, previousCommit: "HEAD" }),
    exec("deploy", { project: "shop", commit: "a".repeat(40), previousCommit: "HEAD" }),
  ]);
  expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
  expect(f.requests.filter((r) => r.method === "PATCH")).toHaveLength(1);
});

test("unverified pin and missing deployment UUID never claim queued success", async () => {
  const f = fixture();
  const exec = createOperationExec({ ...f, fetch: async (req) => {
    if (req.method === "PATCH") return Response.json({ uuid: "uuid-shop" });
    return f.fetch(req);
  } });
  await expect(exec("deploy", { project: "shop", commit: sha, previousCommit: "HEAD" })).rejects.toThrow(/did not confirm pinning/);
  expect(f.requests.filter((r) => r.method === "POST")).toHaveLength(0);
  const empty = createOperationExec({ ...f, fetch: async (req) => req.method === "POST" ? Response.json({ deployments: [{ resource_uuid: "uuid-shop", message: "Unauthorized" }] }) : f.fetch(req) });
  await expect(empty("deploy", { project: "shop" })).rejects.toThrow(/deployment UUID/);
});

test("known MCP instance resolves a concrete app and preserves Cloudflare headers", async () => {
  const f = fixture();
  const deps = { ...f, coolify: () => undefined, coolifyInstances: () => ({ acme: { name: "acme", url: coolify.url, token: coolify.token, headers: { "CF-Access-Client-Id": "CFID" } } }) };
  const plan = await prepareCoolifyDeployment(deps, { instance: " acme ", application: " uuid-shop ", commit: sha, project: "apps-invoice-creator" });
  expect(plan).toMatchObject({ instance: "acme", application: "uuid-shop", project: "apps-invoice-creator" });
  expect(f.requests[0]!.headers.get("CF-Access-Client-Id")).toBe("CFID");
  await expect(prepareCoolifyDeployment(deps, { instance: "unknown", application: "uuid-shop" })).rejects.toThrow(/is not in the host configuration/);
});

test("restart uses application-specific POST endpoint", async () => {
  const f = fixture();
  expect(await createOperationExec(f)("restart-app", { project: "shop" })).toContain("deployment=restart123");
  expect(f.requests[1]!.url).toContain("/applications/uuid-shop/restart");
  expect(f.requests[1]!.method).toBe("POST");
});

async function mappedFailure(promise: Promise<unknown>) {
  try { await promise; } catch (error) { return safeOperationError(error); }
  throw new Error("Expected operation to fail");
}

test("safe errors discard arbitrary thrown messages, bodies, causes, and forged metadata", async () => {
  const unsafe = Object.assign(new Error("SECRET_PASSWORD"), {
    code: "forged", category: "permission", stage: "queue", deploymentId: "forged-id", body: "SECRET_TOKEN", cause: new Error("PRIVATE_KEY"),
  });
  const safe = safeOperationError(unsafe);
  expect(safe).toEqual({ code: "operation_failed", category: "connection", message: expect.any(String) });
  expect(JSON.stringify(safe)).not.toMatch(/SECRET_PASSWORD|SECRET_TOKEN|PRIVATE_KEY|forged/);
  const failed = await mappedFailure(prepareCoolifyDeployment({ coolify: () => { throw unsafe; } }, { project: "shop" }));
  expect(failed).toMatchObject({ code: "operation_failed", stage: "target_validation" });
  expect(JSON.stringify(failed)).not.toContain("SECRET_PASSWORD");
});

test("preparation distinguishes missing configuration, invalid commit, permission, and connection failures", async () => {
  expect(await mappedFailure(prepareCoolifyDeployment({ coolify: () => undefined }, { project: "shop" }))).toMatchObject({
    code: "coolify_credentials_missing", category: "configuration", stage: "target_validation",
  });
  const f = fixture();
  expect(await mappedFailure(prepareCoolifyDeployment(f, { project: "shop", commit: "short" }))).toMatchObject({
    code: "commit_invalid", category: "configuration", stage: "target_validation",
  });
  expect(f.requests).toHaveLength(0);
  for (const status of [401, 403, 500]) {
    const error = await mappedFailure(prepareCoolifyDeployment({ ...f, fetch: async () => new Response("SECRET_TOKEN", { status }) }, { project: "shop" }));
    expect(error).toMatchObject({ code: status < 500 ? "coolify_permission" : "coolify_http", category: status < 500 ? "permission" : "connection", stage: "target_verification" });
    expect(error.message).toContain(String(status));
    expect(JSON.stringify(error)).not.toContain("SECRET_TOKEN");
  }
});

test("stale approval and failed commit pin expose their exact safe stage", async () => {
  const f = fixture();
  expect(await mappedFailure(createOperationExec(f)("deploy", { project: "shop", commit: sha, previousCommit: "a".repeat(40) }))).toMatchObject({
    code: "deployment_plan_stale", category: "decision", stage: "target_verification",
  });
  const exec = createOperationExec({ ...f, fetch: async (req) => req.method === "PATCH" ? new Response("SECRET_TOKEN", { status: 403 }) : f.fetch(req) });
  expect(await mappedFailure(exec("deploy", { project: "shop", commit: sha, previousCommit: "HEAD" }))).toMatchObject({
    code: "coolify_permission", category: "permission", stage: "commit_pin",
  });
  expect(f.requests.filter((req) => req.method === "POST")).toHaveLength(0);
});

test("a lost POST response exposes uncertain queue outcome and never retries automatically", async () => {
  const f = fixture();
  let posts = 0;
  const exec = createOperationExec({ ...f, fetch: async (req) => {
    if (req.method === "POST") { posts++; throw new Error("connection broke with SECRET_TOKEN"); }
    return f.fetch(req);
  } });
  const error = await mappedFailure(exec("deploy", { project: "shop" }));
  expect(error).toMatchObject({ code: "coolify_connection", category: "connection", stage: "queue" });
  expect(error.deploymentId).toBeUndefined();
  expect(error.message).toContain("do not repeat the deploy");
  expect(JSON.stringify(error)).not.toContain("SECRET_TOKEN");
  expect(posts).toBe(1);
});

test("malformed queue responses cannot throw arbitrary upstream fields or pretend success", async () => {
  for (const value of [null, [], { deployments: "SECRET_TOKEN" }, { deployments: [null, { resource_uuid: "uuid-shop", deployment_uuid: "bad id SECRET_TOKEN" }] }]) {
    const f = fixture();
    const exec = createOperationExec({ ...f, fetch: async (req) => req.method === "POST" ? Response.json(value) : f.fetch(req) });
    const error = await mappedFailure(exec("deploy", { project: "shop" }));
    expect(error).toMatchObject({ code: "deployment_queue_unverified", category: "connection", stage: "queue" });
    expect(error.deploymentId).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain("SECRET_TOKEN");
  }
});

test("queued deployment ID survives permission, transport, malformed and commit-verification failures", async () => {
  for (const fail of ["permission", "transport", "malformed", "commit"] as const) {
    const f = fixture();
    let posts = 0;
    const exec = createOperationExec({ ...f, fetch: async (req) => {
      if (req.method === "POST") posts++;
      if (new URL(req.url).pathname === "/api/v1/deployments/deployment123") {
        if (fail === "permission") return new Response("SECRET_TOKEN", { status: 403 });
        if (fail === "transport") throw new Error("SECRET_TOKEN");
        return Response.json(fail === "malformed" ? null : { commit: "SECRET_TOKEN" });
      }
      return f.fetch(req);
    } });
    const error = await mappedFailure(exec("deploy", { project: "shop", commit: sha, previousCommit: "HEAD" }));
    expect(error).toMatchObject({ stage: "deployment_verification", deploymentId: "deployment123" });
    expect(error.code).toBe(fail === "permission" ? "coolify_permission" : fail === "transport" ? "coolify_connection" : "deployment_commit_unverified");
    expect(JSON.stringify(error)).not.toContain("SECRET_TOKEN");
    expect(posts).toBe(1);
  }
});
