import { afterEach, expect, test } from "bun:test";
import type { Option } from "@clack/prompts";
import { ApiClient, type CodexSessionAccountView, type CodexSessionAccountSwitchResult, type SwitchAccountResponse } from "../src/api";
import { pickAndSwitchAccount, type AccountSwitchUi } from "../src/main";

const targetId = "00000000-0000-0000-0000-000000000001";
const session = { id: "dev-games-pdm-5", project: "games", repo: "pdm", agent: "codex" as const };
const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => { for (const server of servers.splice(0)) server.stop(true); });

function setup() {
  const view: CodexSessionAccountView = {
    accounts: [
      { id: "default", label: "Personal", isDefault: true, disabled: false, usage: null, sharedUsageWith: [], available: true, unavailableReason: null },
      { id: targetId, label: "Work", isDefault: false, disabled: false, usage: null, sharedUsageWith: [], available: true, unavailableReason: null },
      { id: "unmounted", label: "Other", isDefault: false, disabled: false, usage: null, sharedUsageWith: [], available: false, unavailableReason: "Account is not mounted." },
      { id: "disabled", label: "Paused", isDefault: false, disabled: true, usage: null, sharedUsageWith: [], available: true, unavailableReason: null },
    ],
    panes: [{ target: "main:0.0", accountId: "default" }],
    currentAccountId: "default",
  };
  const state = {
    view,
    result: { ok: true, accountId: targetId, label: "Work", unchanged: false, panes: [{ target: "main:0.0", outcome: "restarted" }] } as CodexSessionAccountSwitchResult | SwitchAccountResponse,
    status: 200,
    getStatus: 200,
    pick: targetId as string | undefined,
    confirmed: true,
  };
  const requests: { method: string; path: string; body: unknown }[] = [];
  const logs: { level: string; message: string }[] = [];
  const prompts: { message: string; options: Option<string>[] }[] = [];
  const confirmations: string[] = [];
  const server = Bun.serve({ port: 0, fetch: async request => {
    const path = new URL(request.url).pathname;
    requests.push({ method: request.method, path, body: request.method === "POST" ? await request.json().catch(() => null) : null });
    if (request.method === "GET") return Response.json(state.getStatus === 200 ? state.view : { error: "Live account probe failed" }, { status: state.getStatus });
    return Response.json(state.result, { status: state.status });
  } });
  servers.push(server);
  const ui: AccountSwitchUi = {
    select: async (message, options) => { prompts.push({ message, options }); return state.pick; },
    confirm: async message => { confirmations.push(message); return state.confirmed; },
    info: message => { logs.push({ level: "info", message }); },
    warn: message => { logs.push({ level: "warn", message }); },
    error: message => { logs.push({ level: "error", message }); },
    success: message => { logs.push({ level: "success", message }); },
  };
  const deps = { cfg: { devdUrl: "unused" }, api: new ApiClient(`http://127.0.0.1:${server.port}`) };
  return { state, requests, logs, prompts, confirmations, deps, ui };
}

test("F9 Codex reads actual current account, offers usable targets, warns and posts selected account", async () => {
  const h = setup();
  expect(await pickAndSwitchAccount(h.deps, session, h.ui)).toBe(true);
  expect(h.requests).toEqual([
    { method: "GET", path: `/api/sessions/${session.id}/codex-account`, body: null },
    { method: "POST", path: `/api/sessions/${session.id}/codex-account`, body: { accountId: targetId } },
  ]);
  expect(h.prompts[0]!.options.map(o => o.value)).toEqual(["default", targetId, "__back__"]);
  expect(h.prompts[0]!.options[0]!.hint).toContain("current");
  expect(h.logs.some(l => l.message === "Current Codex account: Personal.")).toBe(true);
  expect(h.logs.some(l => l.message.includes("not mounted"))).toBe(true);
  expect(h.logs.some(l => l.message.includes("Paused: account disabled"))).toBe(true);
  expect(h.confirmations[0]).toContain("resumes its exact current conversation");
  expect(h.confirmations[0]).toContain("without starting a new one");
  expect(h.logs.at(-1)?.level).toBe("success");
  expect(h.logs.at(-1)?.message).toContain("same conversations are resumed");
});

test("F9 Codex shows mixed live accounts per pane without claiming a single current account", async () => {
  const h = setup();
  h.state.view.currentAccountId = null;
  h.state.view.panes.push({ target: "main-2:0.0", accountId: targetId });
  h.state.pick = undefined;
  expect(await pickAndSwitchAccount(h.deps, session, h.ui)).toBe(false);
  expect(h.logs[0]?.message).toContain("main:0.0: Personal; main-2:0.0: Work");
  expect(h.prompts[0]!.options.every(o => !o.hint?.includes("current"))).toBe(true);
});

test("F9 Codex cancellation, Back, and current-account selection make no writes", async () => {
  for (const pick of [undefined, "__back__", "default"]) {
    const h = setup();
    h.state.pick = pick;
    expect(await pickAndSwitchAccount(h.deps, session, h.ui)).toBe(false);
    expect(h.requests.map(r => r.method)).toEqual(["GET"]);
    expect(h.confirmations).toEqual([]);
    if (pick === "default") expect(h.logs.at(-1)?.message).toContain("nothing to do");
  }
});

test("F9 Codex rejected confirmation makes no writes", async () => {
  const h = setup();
  h.state.confirmed = false;
  expect(await pickAndSwitchAccount(h.deps, session, h.ui)).toBe(false);
  expect(h.requests.map(r => r.method)).toEqual(["GET"]);
  expect(h.logs.some(l => l.level === "success")).toBe(false);
});

test("F9 Codex blocks unavailable or disabled targets even if the picker returns one", async () => {
  for (const pick of ["unmounted", "disabled"]) {
    const h = setup();
    h.state.pick = pick;
    expect(await pickAndSwitchAccount(h.deps, session, h.ui)).toBe(false);
    expect(h.requests.map(r => r.method)).toEqual(["GET"]);
    expect(h.logs.at(-1)?.level).toBe("error");
  }
});

test("F9 Codex with no running panes or available accounts explains why it cannot switch", async () => {
  for (const noPanes of [true, false]) {
    const h = setup();
    if (noPanes) { h.state.view.panes = []; h.state.view.currentAccountId = null; }
    else h.state.view.accounts.forEach(a => { a.available = false; });
    expect(await pickAndSwitchAccount(h.deps, session, h.ui)).toBe(false);
    expect(h.prompts).toEqual([]);
    expect(h.requests.map(r => r.method)).toEqual(["GET"]);
    expect(h.logs.at(-1)?.message).toMatch(noPanes ? /No running Codex/ : /No selectable Codex/);
  }
});

test("F9 Codex read HTTP failure is visible and never opens a stale picker", async () => {
  const h = setup();
  h.state.getStatus = 502;
  expect(await pickAndSwitchAccount(h.deps, session, h.ui)).toBe(false);
  expect(h.prompts).toEqual([]);
  expect(h.logs.at(-1)).toEqual({ level: "error", message: "Account switch failed: Live account probe failed" });
});

test("F9 Codex POST HTTP or ok:false failure is visible and never returns successful reattach", async () => {
  for (const status of [409, 200]) {
    const h = setup();
    h.state.status = status;
    h.state.result = { ...h.state.result, ok: false, error: "Account busy", panes: [{ target: "main:0.0", outcome: "did-not-return" }] };
    expect(await pickAndSwitchAccount(h.deps, session, h.ui)).toBe(false);
    expect(h.logs.at(-1)?.level).toBe("error");
    expect(h.logs.at(-1)?.message).toContain("Account busy");
    expect(h.logs.some(l => l.level === "success")).toBe(false);
    if (status === 200) expect(h.logs.at(-1)?.message).toContain("main:0.0 (did-not-return)");
  }
});

test("F9 Codex partial outcome stays in menu and names the failed pane", async () => {
  const h = setup();
  h.state.result.panes.push({ target: "main-2:0.0", outcome: "did-not-exit" });
  expect(await pickAndSwitchAccount(h.deps, session, h.ui)).toBe(false);
  expect(h.logs.at(-1)?.level).toBe("warn");
  expect(h.logs.at(-1)?.message).toContain("main-2:0.0 (did-not-exit)");
  expect(h.logs.some(l => l.level === "success")).toBe(false);
});

test("F9 Codex server no-op is reported without claiming a switch", async () => {
  const h = setup();
  h.state.result.unchanged = true;
  h.state.result.panes = [{ target: "main:0.0", outcome: "already-on-account" }];
  expect(await pickAndSwitchAccount(h.deps, session, h.ui)).toBe(false);
  expect(h.logs.at(-1)?.message).toContain("Already on Work — nothing to do");
  expect(h.logs.some(l => l.level === "success")).toBe(false);
});

test("F9 unfinished switch offers only its recovery target and never mistakes it for an account no-op", async () => {
  const h = setup();
  h.state.view.currentAccountId = targetId;
  h.state.view.panes = [{ target: "main:0.0", accountId: targetId, pending: { accountId: targetId, threadId: "11111111-1111-4111-8111-111111111111", phase: "resume" } }];
  expect(await pickAndSwitchAccount(h.deps, session, h.ui)).toBe(true);
  expect(h.prompts[0]!.options.map(o => o.value)).toEqual([targetId, "__back__"]);
  expect(h.prompts[0]!.options[0]!.label).toContain("finish switching");
  expect(h.confirmations[0]).toContain("Finish switching Codex to Work?");
  expect(h.requests.filter(r => r.method === "POST")).toHaveLength(1);
  expect(h.logs.some(l => l.message.includes("Unfinished Codex account switch to Work"))).toBe(true);
});

test("F9 pending stopped conversation cannot switch to a different available account", async () => {
  const h = setup();
  h.state.view.currentAccountId = null;
  h.state.view.panes = [{ target: "main:0.0", accountId: null, pending: { accountId: targetId, threadId: "11111111-1111-4111-8111-111111111111", phase: "resume" } }];
  h.state.view.accounts.find(a => a.id === targetId)!.available = false;
  expect(await pickAndSwitchAccount(h.deps, session, h.ui)).toBe(false);
  expect(h.prompts).toEqual([]);
  expect(h.requests.map(r => r.method)).toEqual(["GET"]);
  expect(h.logs.some(l => l.message.includes("stopped; continuation pending"))).toBe(true);
});

test("F9 Claude uses the automatic endpoint and preserves the exact conversation", async () => {
  const h = setup();
  h.state.result = { ok: true, accountId: "claude-work", label: "Claude Work", exhausted: false, unchanged: false, panes: [{ target: "main:0.0", outcome: "already-on-account" }] };
  expect(await pickAndSwitchAccount(h.deps, { ...session, agent: "claude" }, h.ui)).toBe(true);
  expect(h.requests).toEqual([{ method: "POST", path: `/api/sessions/${session.id}/switch-account`, body: null }]);
  expect(h.confirmations[0]).toContain("Automatically choose");
  expect(h.confirmations[0]).toContain("resumes its exact current conversation");
  expect(h.confirmations[0]).toContain("without starting a new one");
  expect(h.prompts).toEqual([]);
  expect(h.logs.at(-1)?.level).toBe("success");
});

test("F9 Claude cancellation sends no request", async () => {
  const h = setup();
  h.state.confirmed = false;
  expect(await pickAndSwitchAccount(h.deps, { ...session, agent: "claude" }, h.ui)).toBe(false);
  expect(h.requests).toEqual([]);
});

test("F9 Claude no-op, missing account and partial restart remain visible in the menu", async () => {
  for (const mode of ["unchanged", "no-account", "partial"] as const) {
    const h = setup();
    h.state.result = { ok: mode !== "no-account", accountId: mode === "no-account" ? null : "claude-work", label: "Claude Work", exhausted: false, unchanged: mode === "unchanged", panes: mode === "partial" ? [{ target: "main:0.0", outcome: "restarted" }, { target: "main-2:0.0", outcome: "did-not-exit" }] : [] };
    expect(await pickAndSwitchAccount(h.deps, { ...session, agent: "claude" }, h.ui)).toBe(false);
    expect(h.logs.some(l => l.level === "success")).toBe(false);
    expect(h.logs.at(-1)?.message).toMatch(mode === "unchanged" ? /nothing to do/ : mode === "no-account" ? /No usable Anthropic account/ : /main-2:0.0 \(did-not-exit\)/);
  }
});

test("F9 account picker rejects proxy Claude profiles before prompting or calling APIs", async () => {
  for (const agent of ["claude-gpt", "claude-grok", "claude-openrouter", "grok"] as const) {
    const h = setup();
    expect(await pickAndSwitchAccount(h.deps, { ...session, agent }, h.ui)).toBe(false);
    expect(h.requests).toEqual([]);
    expect(h.confirmations).toEqual([]);
    expect(h.logs.at(-1)?.level).toBe("error");
  }
});
