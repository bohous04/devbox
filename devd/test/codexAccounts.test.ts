import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { openDb, getCodexUsage } from "../src/db";
import { CodexAccounts, chooseCodexAccount, codexAccountsRoutes, type CodexAccountView } from "../src/codexAccounts";
import { getCodexAccount, storedCodexAccountUsage } from "../src/codexAccountsDb";

const NOW = 1_787_224_361_140;
function fixture(readServerAuth?: () => Promise<string | null>) {
  const db = openDb(":memory:");
  const volumes = new Map<string, string>();
  const containers = new Map<string, { Status: string; ExitCode: number }>();
  const calls: string[][] = [];
  let usageCalls = 0;
  const auth = (identity: string) => JSON.stringify({ last_refresh: new Date(NOW).toISOString(), tokens: {
    access_token: `SECRET-${identity}`, refresh_token: `REFRESH-${identity}`, account_id: identity,
  } });
  volumes.set("codex-home", auth("main"));
  const run = async (cmd: string[]) => {
    calls.push(cmd);
    const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
    if (cmd[0] === "volume" && cmd[1] === "ls") return ok([...volumes.keys()].join("\n"));
    if (cmd[0] === "volume" && cmd[1] === "create") { volumes.set(cmd[2]!, ""); return ok(cmd[2]); }
    if (cmd[0] === "volume" && cmd[1] === "rm") { volumes.delete(cmd[2]!); return ok(); }
    if (cmd[0] === "ps") return ok();
    if (cmd[0] === "rm") { containers.delete(cmd[2]!); return ok(); }
    if (cmd[0] === "logs") return ok("https://auth.openai.com/codex/device\nABCD-EFGHJ");
    if (cmd[0] === "inspect") return containers.has(cmd.at(-1)!) ? ok(JSON.stringify(containers.get(cmd.at(-1)!))) : { code: 1, stdout: "", stderr: "" };
    if (cmd.includes("--name")) { containers.set(cmd[cmd.indexOf("--name") + 1]!, { Status: "running", ExitCode: 0 }); return ok(); }
    if (cmd.includes("cat")) return ok(volumes.get(cmd[cmd.indexOf("-v") + 1]!.split(":")[0]!) ?? "");
    if (cmd.includes("status")) return ok("Logged in using ChatGPT");
    return ok();
  };
  const service = new CodexAccounts({ db, auth: { run, sleep: async () => {} }, now: () => NOW, readServerAuth,
    fetch: (async (_url: unknown, options: RequestInit) => {
      usageCalls++;
      const token = (options.headers as Record<string, string>).Authorization;
      return Response.json({ plan_type: "plus", primary: { used_percent: token.includes("main") ? 70 : 15, window_minutes: 300 } });
    }) as typeof fetch,
  });
  const app = new Hono().route("/api/codex-accounts", codexAccountsRoutes(service));
  const request = (path = "", method = "GET", body?: unknown) => app.request(`/api/codex-accounts${path}`, {
    method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  const complete = (id: string, identity: string) => {
    volumes.set(`codex-acct-${id}`, auth(identity));
    containers.set(`devbox-codex-login-${id}`, { Status: "exited", ExitCode: 0 });
  };
  return { db, service, request, volumes, calls, complete, auth, usageCalls: () => usageCalls };
}

describe("Codex account API", () => {
  test("preserves default account and singleton usage while independently measuring two logins", async () => {
    const f = fixture();
    const mainAuth = f.volumes.get("codex-home");
    const start = await f.request("/login/start", "POST", { label: "Work" });
    expect(start.status).toBe(200);
    expect(start.headers.get("cache-control")).toBe("no-store");
    const { id } = await start.json() as { id: string };
    expect(await (await f.request(`/${id}/login/status`)).json()).toEqual({ status: "pending" });
    expect(f.service.list().accounts).toHaveLength(1);
    f.complete(id, "work");
    expect(await (await f.request(`/${id}/login/status`)).json()).toEqual({ status: "done" });
    await f.service.poll();
    expect(getCodexUsage(f.db)?.windows_json).toContain('"usedPct":70');
    expect(storedCodexAccountUsage(f.db, id)?.windows_json).toContain('"usedPct":15');
    const body = await (await f.request()).text();
    expect(body).toContain("Work");
    expect(body).not.toMatch(/SECRET|REFRESH|access_token|refresh_token/);
    expect(JSON.stringify(f.db.query("SELECT * FROM codex_accounts").all())).not.toMatch(/SECRET|REFRESH/);
    expect(f.volumes.get("codex-home")).toBe(mainAuth);
    expect(f.calls.filter(cmd => cmd.includes("cat")).every(cmd => cmd.some(arg => arg.endsWith(":ro,nocopy")))).toBe(true);
    expect(f.service.select().accountId).toBe(id);
  });

  test("rejects duplicate primary or pooled subscription and does not activate it", async () => {
    const f = fixture();
    const first = await f.service.start("Work");
    f.complete(first.id, "work");
    await f.service.loginStatus(first.id);
    for (const identity of ["main", "work"]) {
      const duplicate = await f.service.start("Duplicate");
      f.complete(duplicate.id, identity);
      const result = await f.service.loginStatus(duplicate.id);
      expect(result.status).toBe("error");
      expect(result.error).toContain("already connected");
      expect(f.service.list().accounts.some(a => a.id === duplicate.id)).toBe(false);
    }
    expect(f.service.list().accounts).toHaveLength(2);
  });

  test("selection honors preference and disabled states and refuses an unmounted preferred profile", async () => {
    const f = fixture();
    const extra = await f.service.start("Work");
    f.complete(extra.id, "work");
    await f.service.loginStatus(extra.id);
    expect((await f.request("/preference", "POST", { accountId: extra.id })).status).toBe(200);
    expect((await f.request("/select?available=default")).status).toBe(409);
    expect(f.service.select(["default", extra.id]).accountId).toBe(extra.id);
    expect((await f.request(`/${extra.id}`, "PATCH", { disabled: true })).status).toBe(200);
    expect(f.service.list().preferredAccountId).toBe(null);
    expect(f.service.select().accountId).toBe("default");
    expect((await f.request("/preference", "POST", { accountId: extra.id })).status).toBe(400);
    expect((await f.request("/default", "PATCH", { disabled: true })).status).toBe(200);
    expect((await f.request("/select")).status).toBe(409);
  });

  test("cancel removes only the pending profile; malformed requests never alter the original", async () => {
    const f = fixture();
    for (const body of [{ label: "" }, { label: "x".repeat(101) }, { label: 123 }, null])
      expect((await f.request("/login/start", "POST", body)).status).toBe(400);
    expect((await f.request("/default", "DELETE")).status).toBe(400);
    expect((await f.request("/default", "PATCH", { disabled: "false" })).status).toBe(400);
    expect((await f.request("/preference", "POST", {})).status).toBe(400);
    expect((await f.request("/missing", "DELETE")).status).toBe(404);
    const extra = await f.service.start("Work");
    expect((await f.request(`/${extra.id}/login/cancel`, "POST", {})).status).toBe(200);
    expect(getCodexAccount(f.db, extra.id)).toBe(null);
    expect(f.volumes.has(`codex-acct-${extra.id}`)).toBe(false);
    expect(f.volumes.has("codex-home")).toBe(true);
  });

  test("refresh coalesces requests and the API survives legacy wiring", async () => {
    const f = fixture();
    await Promise.all([f.service.refresh("default"), f.service.refresh("default")]);
    expect(f.usageCalls()).toBe(1);
    const missing = new Hono().route("/api/codex-accounts", codexAccountsRoutes());
    expect((await missing.request("/api/codex-accounts")).status).toBe(503);
  });

  test("default account reads the live Codex server login, not the stale volume copy", async () => {
    // Since Codex Remote only the host server rotates the default token; the
    // codex-home volume keeps a copy that expires and is never refreshed again.
    const f = fixture(async () => f.auth("server"));
    await f.service.refresh("default");
    expect(getCodexUsage(f.db)?.state).toBe("ok");
    expect(JSON.parse(getCodexUsage(f.db)!.windows_json)[0].usedPct).toBe(15);
    expect(f.calls.some(cmd => cmd[0] === "run")).toBe(false);
  });

  test("default account falls back to the volume when the server has no login of its own", async () => {
    const f = fixture(async () => null);
    await f.service.refresh("default");
    expect(JSON.parse(getCodexUsage(f.db)!.windows_json)[0].usedPct).toBe(70);
  });

  test("other accounts never read the server login", async () => {
    let serverReads = 0;
    const f = fixture(async () => { serverReads++; return f.auth("server"); });
    const { id } = await (await f.request("/login/start", "POST", { label: "Work" })).json() as { id: string };
    f.complete(id, "work");
    await f.request(`/${id}/login/status`);
    serverReads = 0;
    await f.service.refresh(id);
    expect(serverReads).toBe(0);
  });

  test("missing profiles are not recreated by quota polling", async () => {
    const f = fixture();
    f.volumes.delete("codex-home");
    await f.service.refresh("default");
    expect(getCodexUsage(f.db)?.state).toBe("signed-out");
    expect(f.calls.some(cmd => cmd[0] === "run")).toBe(false);
    expect(f.volumes.size).toBe(0);
  });
});

test("selection uses every quota window and ignores windows whose reset has passed", () => {
  const account = (id: string, five: number, week: number, reset = NOW + 60_000): CodexAccountView => ({
    id, label: id, isDefault: id === "default", disabled: false, sharedUsageWith: [],
    usage: { state: "ok", planType: null, credits: null, error: null, limitReached: null, fetchedAt: NOW,
      windows: [{ kind: "primary", usedPct: five, windowMinutes: 300, resetsAt: reset }, { kind: "secondary", usedPct: week, windowMinutes: 10080, resetsAt: reset }] },
  });
  expect(chooseCodexAccount([account("default", 10, 99), account("work", 40, 50)], null, NOW)?.id).toBe("work");
  expect(chooseCodexAccount([account("default", 100, 100, NOW - 1), account("work", 40, 50)], null, NOW)?.id).toBe("default");
  const blocked = account("default", 0, 0);
  blocked.usage!.limitReached = "limit_reached";
  expect(chooseCodexAccount([blocked, account("work", 40, 50)], null, NOW)?.id).toBe("work");
  blocked.usage!.state = "error";
  blocked.usage!.error = "deactivated_workspace (HTTP 402)";
  expect(chooseCodexAccount([blocked], "default", NOW)).toBe(null);
});


test("detects a legacy profile switching to a pooled identity without conflating separate accounts", async () => {
  const f = fixture();
  const work = await f.service.start("Acme");
  f.complete(work.id, "work");
  await f.service.loginStatus(work.id);
  await f.service.poll();
  expect(f.service.list().accounts.every(a => a.sharedUsageWith.length === 0)).toBe(true);
  f.volumes.set("codex-home", f.volumes.get(`codex-acct-${work.id}`)!);
  await f.service.refresh("default");
  const accounts = f.service.list().accounts;
  expect(accounts.find(a => a.id === "default")!.sharedUsageWith).toEqual(["Acme"]);
  expect(accounts.find(a => a.id === work.id)!.sharedUsageWith).toEqual(["Main account"]);
  f.volumes.delete("codex-home");
  await f.service.refresh("default");
  expect(f.service.list().accounts.every(a => a.sharedUsageWith.length === 0)).toBe(true);
});
