import { describe, expect, test } from "bun:test";
import { CodexSessionAccounts } from "../src/codexSessionAccounts";
import type { CodexAccountView } from "../src/codexAccounts";
import type { ExecResult } from "../src/ccUpkeep";
import { insertSession, openDb, type SessionRow } from "../src/db";

const EXTRA = "84102735-cebc-42bc-bd8b-6a9f75e4b9ce";
const OTHER = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const THREAD = "11111111-2222-4333-8444-000000000001";
const THREAD2 = "11111111-2222-4333-8444-000000000002";
const ROW: SessionRow = {
  id: "dev-games-pdm", folder: "dev", project: "games", repo: "pdm", container: "dev-games-pdm",
  port_base: 40100, status: "running", solo: 0, created_at: 0, last_active_at: 0, important: 0, agent: "codex",
};
const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "", timedOut: false });
const fail = (): ExecResult => ({ code: 1, stdout: "", stderr: "probe unavailable", timedOut: false });
const home = (id: string) => id === "default" ? "/home/dev/.codex" : `/home/dev/.codex-accounts/${id}`;
type TestPane = { target: string; root: number; pid: number; account: string; alive: boolean; comm?: string; threadId: string; resumeId?: string; pending?: string };

function fixture(accounts = ["default"], row: Partial<SessionRow> = {}, hooks: { repairAccountMounts?: (id: string) => Promise<boolean> } = {}) {
  const db = openDb(":memory:");
  insertSession(db, { ...ROW, ...row });
  const catalog: CodexAccountView[] = ["default", EXTRA, OTHER].map(id => ({ id, label: id === "default" ? "Main account" : "Acme", isDefault: id === "default", disabled: false, usage: null, sharedUsageWith: [] }));
  const panes: TestPane[] = accounts.map((account, i) => ({ target: `main:${i}.0`, root: 100 + i * 10, pid: 101 + i * 10, account, alive: true, threadId: i === 0 ? THREAD : THREAD2 }));
  const calls: string[][] = [];
  const sleeps: number[] = [];
  const unavailable = new Map<string, string>();
  const inFlight = new Set<string>();
  const exitFails = new Set<number>();
  const startFails = new Set<string>();
  const quitPending = new Set<string>();
  const statusPending = new Set<string>();
  // Visible TUI per pane: a running turn, and the paused-goal choice after a resume.
  const screens = new Map<string, { busy?: boolean; goal?: "active" | "paused"; goalPrompt?: boolean; answered?: string }>();
  let launchAccount: string | undefined;
  let nextPid = 500;
  let extraTree = "";
  let intercept: ((cmd: string[]) => ExecResult | Promise<ExecResult> | undefined) | undefined;
  const exec = async (_container: string, cmd: string[]) => {
    calls.push(cmd);
    const intercepted = intercept?.(cmd);
    if (intercepted !== undefined) return await intercepted;
    if (cmd[0] === "python3" && cmd[2]!.includes("CODEX_SESSION_ACCOUNT_PREFLIGHT"))
      return ok(JSON.stringify(Object.fromEntries((JSON.parse(cmd[3]!) as string[]).map(id => [id, unavailable.get(id) ?? null]))));
    if (cmd[0] === "tmux" && cmd[1] === "list-panes") return ok(panes.map(p => `${p.target}\t${p.root}${cmd.at(-1)!.includes("@devd_codex_continuation") ? `\t${p.pending ?? ""}` : ""}`).join("\n"));
    if (cmd[0] === "tmux" && cmd[1] === "set-option" && cmd.includes("@devd_codex_continuation")) {
      const pane = panes.find(p => p.target === cmd[cmd.indexOf("-t") + 1])!;
      pane.pending = cmd.includes("-u") ? undefined : cmd[cmd.indexOf("@devd_codex_continuation") + 1];
      return ok();
    }
    if (cmd[0] === "ps") return ok(panes.map(p => `${p.root} 1 900 zsh\n${p.alive ? `${p.pid} ${p.root} 100 ${p.comm ?? "codex"}` : ""}`).join("\n") + extraTree);
    if (cmd[0] === "python3" && cmd[2]!.includes("CODEX_PROCESS_ACCOUNT_PROBE")) {
      const p = panes.find(p => p.alive && String(p.pid) === cmd[3]);
      return p ? ok(JSON.stringify({ CODEX_HOME: home(p.account), HOME: "/home/dev",
        CODEX_SQLITE_HOME: p.account === "default" ? null : home(p.account),
        DEVD_CODEX_SHARED_HOME: p.account === "default" ? null : home("default"),
        DEVD_CODEX_REMOTE: p.account === "default" ? null : "0",
        resumeThreadId: p.resumeId ?? null,
      })) : fail();
    }
    if (cmd[0] === "python3" && cmd[2]!.includes("CODEX_EXIT_CAPTURE")) {
      if (cmd[3] === "begin") return ok('{"capture":"/tmp/devd-codex-continuation-test"}');
      if (cmd[3] === "finish") return ok(JSON.stringify({ threadId: panes.find(p => p.target === cmd[4])!.threadId }));
      if (cmd[3] === "peek-status") return ok(JSON.stringify({ threadId: panes.find(p => p.target === cmd[4])!.threadId }));
      return ok('{"ok":true}');
    }
    if (cmd[0] === "python3" && cmd[3] === "transfer") return ok(JSON.stringify({ ok: true, threadId: cmd[cmd.indexOf("--thread-id") + 1], cwd: "/workspace" }));
    if (cmd[0] === "python3" && cmd[3] === "grant-full-access") return ok(JSON.stringify({ ok: true, threadId: cmd[cmd.indexOf("--thread-id") + 1] }));
    if (cmd[0] === "python3" && cmd[3] === "verify") return ok(JSON.stringify({ ok: true, threadId: cmd[cmd.indexOf("--thread-id") + 1] }));
    if (cmd[0] === "tmux" && cmd[1] === "capture-pane") {
      const s = screens.get(cmd[4]!) ?? {};
      return ok(s.goalPrompt ? "Resume paused goal?\n› 1. Resume goal\n  2. Leave paused\n  enter select · esc back"
        : `› Ask Codex to do anything\n  ${s.busy ? "Working (3s • esc to interrupt)" : "Ready"}${s.goal === "active" ? " · Pursuing goal (1h)" : s.goal === "paused" ? " · Goal paused (/goal resume)" : ""}\n  ? for shortcuts`);
    }
    if (cmd[0] === "tmux" && cmd[1] === "send-keys") {
      const p = panes.find(p => p.target === cmd[3]);
      const screen = screens.get(cmd[3]!);
      if (screen?.busy && (cmd.includes("/quit") || cmd.includes("/status"))) return ok(); // swallowed by the running turn
      if (screen && cmd[4] === "Escape") { screen.busy = false; return ok(); }
      if (screen?.goalPrompt && ["1", "2"].includes(cmd[4]!)) { screen.goalPrompt = false; screen.answered = cmd[4]; return ok(); }
      if (cmd.includes("/quit")) {
        if (!p || exitFails.has(p.pid)) return fail();
        quitPending.add(p.target);
        return ok();
      }
      if (p && cmd.includes("/status")) { statusPending.add(p.target); return ok(); }
      if (p && cmd[4] === "Enter" && statusPending.delete(p.target)) return ok();
      if (p && cmd[4] === "Enter" && quitPending.delete(p.target)) {
        p.alive = false;
        return ok();
      }
      if (!p || startFails.has(p.target)) return fail();
      const selected = cmd[4]!.match(/DEVD_CODEX_ACCOUNT_ID='([^']+)'/)?.[1];
      if (!selected) throw new Error("unexpected launch");
      p.account = launchAccount ?? selected;
      p.resumeId = cmd[4]!.match(/\bresume ([0-9a-f-]+)$/)?.[1];
      if (!p.resumeId) throw new Error("a new conversation must never be launched");
      p.pid = nextPid++;
      p.alive = true;
      if (screen?.goal) screen.goalPrompt = true;
      return ok();
    }
    return ok();
  };
  const service = new CodexSessionAccounts({
    db, accounts: { list: () => ({ accounts: catalog, preferredAccountId: null }) }, inFlight, exec,
    sleep: async ms => { sleeps.push(ms); }, now: () => 123,
    repairAccountMounts: hooks.repairAccountMounts,
  });
  return {
    service, db, panes, calls, sleeps, unavailable, inFlight, catalog, exitFails, startFails, screens,
    setIntercept: (value: typeof intercept) => { intercept = value; },
    setLaunchAccount: (value: string) => { launchAccount = value; },
    setExtraTree: (value: string) => { extraTree = value; },
  };
}
const mutations = (f: ReturnType<typeof fixture>) => f.calls.filter(c => c[0] === "kill" || (c[0] === "tmux" && ["send-keys", "set-environment", "set-option"].includes(c[1]!)));
const starts = (f: ReturnType<typeof fixture>) => f.calls.filter(c => c[1] === "send-keys" && c[4]!.includes("/usr/local/bin/co"));
const grants = (f: ReturnType<typeof fixture>) => f.calls.filter(c => c[0] === "python3" && c[3] === "grant-full-access").map(c => [c[c.indexOf("--home") + 1], c[c.indexOf("--thread-id") + 1]]);
const exits = (f: ReturnType<typeof fixture>) => f.calls.filter(c => c[1] === "send-keys" && c.includes("/quit")).map(c => c[3]);

describe("Codex session account switching", () => {
  test("missing profile mount disables the option and rejects before stopping Codex", async () => {
    const f = fixture();
    f.unavailable.set(EXTRA, "This account is not mounted in this session.");
    const view = await f.service.view(ROW.id);
    expect(view.currentAccountId).toBe("default");
    expect(view.accounts.find(a => a.id === EXTRA)).toMatchObject({ available: false, unavailableReason: "This account is not mounted in this session." });
    await expect(f.service.switch(ROW.id, EXTRA)).rejects.toMatchObject({ status: 409 });
    expect(mutations(f)).toEqual([]);
  });

  test("idle session remounts missing accounts instead of asking the operator to recreate", async () => {
    let repairs = 0;
    const f = fixture(["default"], {}, {
      repairAccountMounts: async () => {
        repairs++;
        f.unavailable.delete(EXTRA);
        return true;
      },
    });
    f.panes[0]!.alive = false;
    f.unavailable.set(EXTRA, "This account is not mounted in this session. Recreate this session after finishing your work.");
    const view = await f.service.view(ROW.id);
    expect(repairs).toBe(1);
    expect(view.accounts.find(a => a.id === EXTRA)?.unavailableReason)
      .toBe("There is no running Codex pane in this session. Start Codex in Terminal first.");
    await expect(f.service.switch(ROW.id, EXTRA)).rejects.toMatchObject({
      status: 409,
      message: "There is no running Codex pane in this session. Start Codex in Terminal first.",
    });
    expect(repairs).toBe(2);
    expect(mutations(f)).toEqual([]);
  });

  test("a live Codex pane is left running when an extra account is not mounted", async () => {
    let repairs = 0;
    const f = fixture(["default"], {}, { repairAccountMounts: async () => { repairs++; f.unavailable.delete(EXTRA); return true; } });
    f.unavailable.set(EXTRA, "This account is not mounted in this session. Recreate this session after finishing your work.");
    const view = await f.service.view(ROW.id);
    expect(repairs).toBe(0);
    expect(view.accounts.find(a => a.id === EXTRA)?.unavailableReason)
      .toBe("This account is not mounted in this session. Recreate this session after finishing your work.");
    expect(f.panes[0]!.alive).toBe(true);
  });

  test("known account resumes the exact current conversation with reset profile environment and verified writer", async () => {
    const f = fixture();
    const result = await f.service.switch(ROW.id, EXTRA);
    expect(result).toEqual({ ok: true, accountId: EXTRA, label: "Acme", unchanged: false, panes: [{ target: "main:0.0", outcome: "restarted", threadId: THREAD }] });
    const start = starts(f)[0]![4]!;
    expect(start).toBe(`unset CODEX_SQLITE_HOME DEVD_CODEX_SHARED_HOME DEVD_CODEX_REMOTE; export CODEX_HOME='/home/dev/.codex' DEVD_CODEX_ACCOUNT_ID='${EXTRA}'; /usr/local/bin/co -C '/workspace' -c 'projects={"/workspace"={trust_level="trusted"}}' resume ${THREAD}`);
    expect(start).not.toMatch(/--last|--continue|fork/);
    expect(f.calls.filter(c => c[0] === "kill")).toEqual([]);
    expect(exits(f)).toEqual(["main:0.0"]);
    expect(f.calls.find(c => c.includes("/quit"))).not.toContain("Enter");
    expect(f.sleeps[0]).toBe(500);
    const transferAt = f.calls.findIndex(c => c[0] === "python3" && c[3] === "transfer");
    const finishAt = f.calls.findIndex(c => c[0] === "python3" && c[3] === "finish");
    const startAt = f.calls.indexOf(starts(f)[0]!);
    expect(transferAt).toBeGreaterThan(finishAt);
    expect(startAt).toBeGreaterThan(transferAt);
    expect(f.calls.filter(c => c[1] === "set-environment")).toEqual([["tmux", "set-environment", "-g", "DEVD_CODEX_ACCOUNT_ID", EXTRA]]);
    expect((await f.service.view(ROW.id)).currentAccountId).toBe(EXTRA);
  });

  test("switches extra account back to default and preserves central Remote service", async () => {
    const f = fixture([EXTRA]);
    f.setExtraTree("\n9999 1 1000 codex\n"); // Central service is outside the pane tree.
    expect((await f.service.switch(ROW.id, "default")).ok).toBe(true);
    const command = starts(f)[0]![4]!;
    expect(command).toContain("DEVD_CODEX_ACCOUNT_ID='default'");
    expect(command).toContain("unset CODEX_SQLITE_HOME DEVD_CODEX_SHARED_HOME DEVD_CODEX_REMOTE");
    expect(command).not.toContain("DEVD_CODEX_REMOTE=0");
    expect(command).not.toContain("trust_level");
    expect(f.calls.filter(c => c[0] === "kill")).toEqual([]);
    expect(exits(f)).toEqual(["main:0.0"]);
    expect(command).toContain(`/usr/local/bin/co -C '/workspace' resume ${THREAD}`);
    expect(grants(f)).toEqual([["/home/dev/.codex", THREAD]]);
    expect((await f.service.view(ROW.id)).currentAccountId).toBe("default");
  });

  test("a resume onto the central server whose permissions cannot be restored stays pending", async () => {
    const f = fixture([EXTRA]);
    let grantWorks = false;
    f.setIntercept(cmd => cmd[0] === "python3" && cmd[3] === "grant-full-access" && !grantWorks ? fail() : undefined);
    const result = await f.service.switch(ROW.id, "default");
    expect(result.ok).toBe(false);
    expect(result.panes).toEqual([{ target: "main:0.0", outcome: "permissions-not-restored", threadId: THREAD }]);
    expect((await f.service.view(ROW.id)).panes[0]!.pending).toMatchObject({ accountId: "default", phase: "resume" });
    grantWorks = true;
    const view = await f.service.view(ROW.id);
    expect(view.currentAccountId).toBe("default");
    expect(f.panes[0]!.pending).toBeUndefined();
  });

  test("switching to a secondary account never touches central-server permissions", async () => {
    const f = fixture();
    expect((await f.service.switch(ROW.id, EXTRA)).ok).toBe(true);
    expect(grants(f)).toEqual([]);
  });

  test("already selected panes are not restarted", async () => {
    const f = fixture([EXTRA, EXTRA]);
    const result = await f.service.switch(ROW.id, EXTRA);
    expect(result.ok).toBe(true);
    expect(result.unchanged).toBe(true);
    expect(result.panes.every(p => p.outcome === "already-on-account")).toBe(true);
    expect(f.calls.some(c => c[0] === "kill" || c[1] === "send-keys")).toBe(false);
  });

  test("duplicate views of one conversation are refused before stopping either secondary-account view", async () => {
    const f = fixture(["default", "default"]);
    f.panes[1]!.threadId = THREAD;
    const result = await f.service.switch(ROW.id, EXTRA);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Close duplicate views");
    expect(exits(f)).toEqual([]);
    expect(starts(f)).toEqual([]);
    expect(f.calls.some(c => c[3] === "transfer")).toBe(false);
    expect(f.panes.every(p => p.alive && !p.pending)).toBe(true);
  });

  test("first target-profile launch scopes workspace trust to its exact restored cwd without persisting broad trust", async () => {
    const f = fixture();
    f.setIntercept(cmd => cmd[0] === "python3" && cmd[3] === "transfer"
      ? ok(JSON.stringify({ ok: true, threadId: THREAD, cwd: "/workspaces/dev-games-pdm/apps/ui.v2" })) : undefined);
    expect((await f.service.switch(ROW.id, EXTRA)).ok).toBe(true);
    const launch = starts(f)[0]![4]!;
    expect(launch).toContain(`/usr/local/bin/co -C '/workspaces/dev-games-pdm/apps/ui.v2'`);
    expect(launch).toContain(`-c 'projects={"/workspaces/dev-games-pdm/apps/ui.v2"={trust_level="trusted"}}' resume ${THREAD}`);
    const override = launch.match(/-c '([^']+)'/)![1]!;
    expect(override.slice(0, override.indexOf("="))).toBe("projects");
    expect(Bun.TOML.parse(override)).toEqual({ projects: { "/workspaces/dev-games-pdm/apps/ui.v2": { trust_level: "trusted" } } });
    expect(f.calls.some(c => c.includes("config.toml"))).toBe(false);
  });

  test("a mixed session only restarts panes still on another account", async () => {
    const f = fixture([EXTRA, "default"]);
    expect((await f.service.view(ROW.id)).currentAccountId).toBeNull();
    const result = await f.service.switch(ROW.id, EXTRA);
    expect(result.panes).toEqual([{ target: "main:0.0", outcome: "already-on-account" }, { target: "main:1.0", outcome: "restarted", threadId: THREAD2 }]);
    expect(exits(f)).toEqual(["main:1.0"]);
    expect(result.ok).toBe(true);
  });

  test("partial failure reports successful panes and does not update future-pane selection", async () => {
    const f = fixture(["default", "default"]);
    f.startFails.add("main:1.0");
    const result = await f.service.switch(ROW.id, EXTRA);
    expect(result.ok).toBe(false);
    expect(result.panes).toEqual([{ target: "main:0.0", outcome: "restarted", threadId: THREAD }, { target: "main:1.0", outcome: "did-not-return", threadId: THREAD2 }]);
    expect(result.error).toContain("Successfully switched panes keep their resumed conversation");
    expect(f.calls.some(c => c[1] === "set-environment")).toBe(false);
    const view = await f.service.view(ROW.id);
    expect(view.currentAccountId).toBeNull();
    expect(view.panes).toEqual([{ target: "main:0.0", accountId: EXTRA }, { target: "main:1.0", accountId: null, pending: { accountId: EXTRA, threadId: THREAD2, phase: "resume" } }]);
  });

  test("a resume that succeeded after verification gave up is settled by the next view without touching the pane", async () => {
    const f = fixture();
    let verifies = false;
    f.setIntercept(cmd => cmd[0] === "python3" && cmd[3] === "verify" && !verifies ? fail() : undefined);
    const result = await f.service.switch(ROW.id, EXTRA);
    expect(result.panes).toEqual([{ target: "main:0.0", outcome: "conversation-not-verified", threadId: THREAD }]);
    expect(f.panes[0]!.pending).toBeDefined();
    const stillLoading = await f.service.view(ROW.id);
    expect(stillLoading.panes[0]).toMatchObject({ accountId: EXTRA, pending: { accountId: EXTRA, phase: "resume" } });

    verifies = true;
    const before = mutations(f).length;
    const view = await f.service.view(ROW.id);
    expect(view.panes).toEqual([{ target: "main:0.0", accountId: EXTRA }]);
    expect(view.currentAccountId).toBe(EXTRA);
    expect(f.panes[0]!.pending).toBeUndefined();
    expect(mutations(f).slice(before).filter(c => c[1] === "send-keys")).toEqual([]);
    expect(f.calls.filter(c => c[1] === "set-environment").at(-1)).toEqual(["tmux", "set-environment", "-g", "DEVD_CODEX_ACCOUNT_ID", EXTRA]);
  });

  test("a view never settles a resume running a different conversation or during a lifecycle operation", async () => {
    const f = fixture();
    let verifies = false;
    f.setIntercept(cmd => cmd[0] === "python3" && cmd[3] === "verify" && !verifies ? fail() : undefined);
    await f.service.switch(ROW.id, EXTRA);
    verifies = true;
    f.inFlight.add(ROW.id);
    expect((await f.service.view(ROW.id)).panes[0]!.pending).toBeDefined();
    f.inFlight.delete(ROW.id);
    f.panes[0]!.resumeId = OTHER;
    expect((await f.service.view(ROW.id)).panes[0]!.pending).toBeDefined();
    expect(f.panes[0]!.pending).toBeDefined();
  });

  test("failed launch leaves pane stopped and reports did-not-return", async () => {
    const f = fixture();
    f.startFails.add("main:0.0");
    const result = await f.service.switch(ROW.id, EXTRA);
    expect(result.ok).toBe(false);
    expect(result.panes).toEqual([{ target: "main:0.0", outcome: "did-not-return", threadId: THREAD }]);
    expect(f.panes[0]!.alive).toBe(false);
    expect(f.calls.some(c => c[1] === "set-environment")).toBe(false);
  });

  test("a running replacement on the wrong account is never accepted as success", async () => {
    const f = fixture();
    f.setLaunchAccount("default");
    const result = await f.service.switch(ROW.id, EXTRA);
    expect(result.ok).toBe(false);
    expect(result.panes).toEqual([{ target: "main:0.0", outcome: "account-not-verified", threadId: THREAD }]);
    expect(f.calls.some(c => c[1] === "set-environment")).toBe(false);
    const view = await f.service.view(ROW.id);
    expect(view.currentAccountId).toBeNull();
    expect(view.panes[0]).toMatchObject({ accountId: "default", pending: { accountId: EXTRA, threadId: THREAD, phase: "resume" } });
  });

  test("the newly captured thread wins over stale launch argv after changing conversations", async () => {
    const f = fixture();
    f.panes[0]!.resumeId = OTHER;
    const result = await f.service.switch(ROW.id, EXTRA);
    expect(result.ok).toBe(true);
    expect(result.panes[0]!.threadId).toBe(THREAD);
    expect(starts(f)[0]![4]).toContain(`resume ${THREAD}`);
    expect(starts(f)[0]![4]).not.toContain(OTHER);
  });

  test("an exit without its banner continues the conversation the live pane reported", async () => {
    const f = fixture();
    f.setIntercept(cmd => cmd[0] === "python3" && cmd[3] === "finish" ? ok('{"threadId":null}') : undefined);
    const result = await f.service.switch(ROW.id, EXTRA);
    expect(result.ok).toBe(true);
    expect(f.panes[0]!.resumeId).toBe(THREAD);
  });

  test("a banner naming another conversation than the live pane reported stops without a fresh chat", async () => {
    const f = fixture();
    f.setIntercept(cmd => cmd[0] === "python3" && cmd[3] === "finish" ? ok(JSON.stringify({ threadId: THREAD2 })) : undefined);
    const result = await f.service.switch(ROW.id, EXTRA);
    expect(result.ok).toBe(false);
    expect(starts(f)).toEqual([]);
    expect(f.calls.some(c => c[3] === "transfer")).toBe(false);
  });

  test("a running goal turn is interrupted before exit and its goal resumes on the new account", async () => {
    const f = fixture();
    f.screens.set("main:0.0", { busy: true, goal: "active" });
    const result = await f.service.switch(ROW.id, EXTRA);
    expect(result.ok).toBe(true);
    const escape = f.calls.findIndex(c => c[1] === "send-keys" && c[4] === "Escape");
    expect(escape).toBeGreaterThan(-1);
    expect(escape).toBeLessThan(f.calls.findIndex(c => c[1] === "send-keys" && c.includes("/quit")));
    expect(f.screens.get("main:0.0")!.answered).toBe("1");
    expect(f.panes[0]!.resumeId).toBe(THREAD);
  });

  test("a goal the user had paused stays paused after the switch", async () => {
    const f = fixture();
    f.screens.set("main:0.0", { goal: "paused" });
    const result = await f.service.switch(ROW.id, EXTRA);
    expect(result.ok).toBe(true);
    expect(f.calls.some(c => c[1] === "send-keys" && c[4] === "Escape")).toBe(false);
    expect(f.screens.get("main:0.0")!.answered).toBe("2");
  });

  test("missing exact exit identity stops with an error and never launches a fresh chat", async () => {
    const f = fixture();
    f.setIntercept(cmd => cmd[0] === "python3" && (cmd[3] === "finish" || cmd[3] === "peek-status") ? ok('{"threadId":null}') : undefined);
    const result = await f.service.switch(ROW.id, EXTRA);
    expect(result.ok).toBe(false);
    expect(result.panes[0]!.outcome).toBe("conversation-transfer-failed");
    expect(f.panes[0]!.alive).toBe(false);
    expect(starts(f)).toEqual([]);
    expect(f.calls.some(c => c[3] === "transfer")).toBe(false);
  });

  test("an existing output capture prevents exit instead of hijacking the pane logger", async () => {
    const f = fixture();
    f.setIntercept(cmd => cmd[0] === "python3" && cmd[3] === "begin" ? fail() : undefined);
    const result = await f.service.switch(ROW.id, EXTRA);
    expect(result.ok).toBe(false);
    expect(f.panes[0]!.alive).toBe(true);
    expect(exits(f)).toEqual([]);
    expect(starts(f)).toEqual([]);
  });

  test("failed or mismatched transfer receipts never fall back to a fresh start", async () => {
    for (const response of [fail(), ok(JSON.stringify({ ok: true, threadId: OTHER, cwd: "/workspace" }))]) {
      const f = fixture();
      f.setIntercept(cmd => cmd[0] === "python3" && cmd[3] === "transfer" ? response : undefined);
      const result = await f.service.switch(ROW.id, EXTRA);
      expect(result.ok).toBe(false);
      expect(result.panes[0]).toMatchObject({ outcome: "conversation-transfer-failed", threadId: THREAD });
      expect(starts(f)).toEqual([]);
      expect(result.error).toContain("Existing conversation history was preserved");
    }
  });

  test("correct account and replacement PID do not substitute for the exact resumed UUID", async () => {
    const f = fixture();
    f.setIntercept(cmd => cmd[0] === "python3" && cmd[2]!.includes("CODEX_PROCESS_ACCOUNT_PROBE") && cmd[3] === "500"
      ? ok(JSON.stringify({ CODEX_HOME: home(EXTRA), HOME: "/home/dev", CODEX_SQLITE_HOME: home(EXTRA), DEVD_CODEX_REMOTE: "0", resumeThreadId: OTHER })) : undefined);
    const result = await f.service.switch(ROW.id, EXTRA);
    expect(result.ok).toBe(false);
    expect(result.panes[0]!.outcome).toBe("conversation-not-verified");
    expect(f.calls.some(c => c[1] === "set-environment")).toBe(false);
  });

  test("correct resume argv still requires the selected conversation's live writer", async () => {
    const f = fixture();
    f.setIntercept(cmd => cmd[0] === "python3" && cmd[3] === "verify" ? fail() : undefined);
    const result = await f.service.switch(ROW.id, EXTRA);
    expect(result.ok).toBe(false);
    expect(result.panes[0]!.outcome).toBe("conversation-not-verified");
    expect(f.calls.some(c => c[1] === "set-environment")).toBe(false);
  });

  test("waits for the resumed writer to initialize after the replacement process starts", async () => {
    const f = fixture();
    let probes = 0;
    f.setIntercept(cmd => cmd[0] === "python3" && cmd[3] === "verify" && ++probes < 3 ? fail() : undefined);
    const result = await f.service.switch(ROW.id, EXTRA);
    expect(result.ok).toBe(true);
    expect(probes).toBeGreaterThanOrEqual(3);
    expect(result.panes[0]!.threadId).toBe(THREAD);
  });

  test("live process profile wins over stale tmux pane metadata and nested Codex subagent", async () => {
    const f = fixture([EXTRA]);
    f.setExtraTree("\n777 101 20 codex\n");
    f.setIntercept(cmd => cmd[1] === "show-options" ? ok("default") : undefined);
    const view = await f.service.view(ROW.id);
    expect(view.currentAccountId).toBe(EXTRA);
    const envReads = f.calls.filter(c => c[0] === "python3" && c[2]!.includes("CODEX_PROCESS_ACCOUNT_PROBE"));
    expect(envReads.map(c => c[3])).toEqual(["101"]);
    expect(f.calls.some(c => c[1] === "show-options")).toBe(false);
  });

  test("unreadable account environment fails closed before mutation", async () => {
    const f = fixture();
    f.setIntercept(cmd => cmd[0] === "python3" && cmd[2]!.includes("CODEX_PROCESS_ACCOUNT_PROBE") ? fail() : undefined);
    await expect(f.service.switch(ROW.id, EXTRA)).rejects.toMatchObject({ status: 502 });
    expect(mutations(f)).toEqual([]);
    expect(f.inFlight.size).toBe(0);
  });

  test("unknown CODEX_HOME is not silently interpreted as default", async () => {
    const f = fixture();
    f.setIntercept(cmd => cmd[0] === "python3" && cmd[2]!.includes("CODEX_PROCESS_ACCOUNT_PROBE") ? ok('{"CODEX_HOME":"/tmp/custom-profile","HOME":"/home/dev"}') : undefined);
    const view = await f.service.view(ROW.id);
    expect(view.currentAccountId).toBeNull();
    expect(view.accounts.every(a => !a.available)).toBe(true);
    await expect(f.service.switch(ROW.id, "default")).rejects.toMatchObject({ status: 502 });
    expect(mutations(f)).toEqual([]);
  });

  test("default home can be inferred only from the actual process HOME", async () => {
    const f = fixture();
    f.setIntercept(cmd => cmd[0] === "python3" && cmd[2]!.includes("CODEX_PROCESS_ACCOUNT_PROBE") ? ok('{"CODEX_HOME":null,"HOME":"/home/dev"}') : undefined);
    expect((await f.service.view(ROW.id)).currentAccountId).toBe("default");
  });

  test("conflicting SQLite, shared home or Remote environment never identifies an isolated account", async () => {
    for (const conflict of [
      { CODEX_SQLITE_HOME: home("default") },
      { CODEX_SQLITE_HOME: null },
      { DEVD_CODEX_REMOTE: "1" },
      { DEVD_CODEX_REMOTE: null },
      { DEVD_CODEX_SHARED_HOME: home(OTHER) },
    ]) {
      const f = fixture([EXTRA]);
      f.setIntercept(cmd => cmd[0] === "python3" && cmd[2]!.includes("CODEX_PROCESS_ACCOUNT_PROBE") ? ok(JSON.stringify({
        CODEX_HOME: home(EXTRA), HOME: "/home/dev", CODEX_SQLITE_HOME: home(EXTRA), DEVD_CODEX_REMOTE: "0", DEVD_CODEX_SHARED_HOME: home("default"), ...conflict,
      })) : undefined);
      expect((await f.service.view(ROW.id)).currentAccountId).toBeNull();
      await expect(f.service.switch(ROW.id, "default")).rejects.toMatchObject({ status: 502 });
      expect(mutations(f)).toEqual([]);
    }
  });

  test("default account rejects inherited secondary SQLite or disabled Remote state", async () => {
    for (const conflict of [{ CODEX_SQLITE_HOME: home(EXTRA) }, { DEVD_CODEX_REMOTE: "0" }]) {
      const f = fixture();
      f.setIntercept(cmd => cmd[0] === "python3" && cmd[2]!.includes("CODEX_PROCESS_ACCOUNT_PROBE") ? ok(JSON.stringify({
        CODEX_HOME: home("default"), HOME: "/home/dev", ...conflict,
      })) : undefined);
      expect((await f.service.view(ROW.id)).currentAccountId).toBeNull();
      await expect(f.service.switch(ROW.id, EXTRA)).rejects.toMatchObject({ status: 502 });
      expect(mutations(f)).toEqual([]);
    }
  });

  test("missing helper or unreadable auth disables the account before restart", async () => {
    for (const reason of ["This session needs an updated Codex account launcher.", "The account credentials cannot be read."]) {
      const f = fixture();
      f.unavailable.set(EXTRA, reason);
      await expect(f.service.switch(ROW.id, EXTRA)).rejects.toMatchObject({ status: 409, message: reason });
      expect(mutations(f)).toEqual([]);
    }
  });

  test("preflight failure and malformed output fail closed", async () => {
    for (const response of [fail(), ok("{}"), ok("invalid"), { ...ok(), timedOut: true }]) {
      const f = fixture();
      f.setIntercept(cmd => cmd[0] === "python3" && cmd[2]!.includes("CODEX_SESSION_ACCOUNT_PREFLIGHT") ? response : undefined);
      await expect(f.service.switch(ROW.id, EXTRA)).rejects.toMatchObject({ status: 502 });
      expect(mutations(f)).toEqual([]);
      expect(f.inFlight.size).toBe(0);
    }
  });

  test("disabled, unknown, pending and malformed account choices cannot restart panes", async () => {
    const f = fixture();
    f.catalog.find(a => a.id === EXTRA)!.disabled = true;
    await expect(f.service.switch(ROW.id, EXTRA)).rejects.toMatchObject({ status: 409 });
    for (const invalid of [undefined, {}, 4, "", "DEFAULT", "../../auth", `${EXTRA}; co`, `${EXTRA}\n`])
      await expect(f.service.switch(ROW.id, invalid)).rejects.toMatchObject({ status: 400 });
    await expect(f.service.switch(ROW.id, "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee")).rejects.toMatchObject({ status: 404 });
    expect(mutations(f)).toEqual([]);
  });

  test("native Codex and running-session guards reject before exec", async () => {
    for (const row of [{ agent: "claude" as const }, { agent: "claude-gpt" as const }, { status: "stopped" as const }]) {
      const f = fixture(["default"], row);
      await expect(f.service.switch(ROW.id, EXTRA)).rejects.toMatchObject({ status: 409 });
      await expect(f.service.view(ROW.id)).rejects.toMatchObject({ status: 409 });
      expect(f.calls).toEqual([]);
    }
    await expect(fixture().service.switch("missing", EXTRA)).rejects.toMatchObject({ status: 404 });
  });

  test("no Codex panes disables actions and leaves shell-only panes untouched", async () => {
    const f = fixture();
    f.panes[0]!.alive = false;
    const view = await f.service.view(ROW.id);
    expect(view.panes).toEqual([]);
    expect(view.accounts.every(a => !a.available)).toBe(true);
    await expect(f.service.switch(ROW.id, EXTRA)).rejects.toMatchObject({ status: 409 });
    expect(mutations(f)).toEqual([]);
  });

  test("non-Codex pane in a native Codex session is left alone", async () => {
    const f = fixture(["default", "default"]);
    f.panes[1]!.comm = "claude";
    expect((await f.service.switch(ROW.id, EXTRA)).panes).toEqual([{ target: "main:0.0", outcome: "restarted", threadId: THREAD }]);
    expect(exits(f)).toEqual(["main:0.0"]);
  });

  test("Codex launched as a child tool of a Claude pane is not a Codex TUI target", async () => {
    const f = fixture(["default", "default"]);
    f.panes[1]!.comm = "claude";
    f.setExtraTree("\n777 111 20 codex\n");
    expect((await f.service.switch(ROW.id, EXTRA)).panes).toEqual([{ target: "main:0.0", outcome: "restarted", threadId: THREAD }]);
    expect(exits(f)).toEqual(["main:0.0"]);
  });

  test("shared lifecycle lock rejects another operation without exec", async () => {
    const f = fixture();
    f.inFlight.add(ROW.id);
    await expect(f.service.switch(ROW.id, EXTRA)).rejects.toMatchObject({ status: 409 });
    expect(f.calls).toEqual([]);
    expect(f.inFlight.has(ROW.id)).toBe(true);
  });

  test("simultaneous switch calls share the lock through async preflight", async () => {
    const f = fixture();
    let release!: (value: ExecResult) => void;
    const pending = new Promise<ExecResult>(resolve => { release = resolve; });
    f.setIntercept(cmd => cmd[0] === "python3" && cmd[2]!.includes("CODEX_SESSION_ACCOUNT_PREFLIGHT") ? pending : undefined);
    const first = f.service.switch(ROW.id, EXTRA);
    await expect(f.service.switch(ROW.id, "default")).rejects.toMatchObject({ status: 409 });
    release(ok(JSON.stringify({ [EXTRA]: null })));
    expect((await first).ok).toBe(true);
    expect(f.inFlight.size).toBe(0);
  });

  test("failed future-pane environment update reports incomplete result after verified restart", async () => {
    const f = fixture();
    f.setIntercept(cmd => cmd[1] === "set-environment" ? fail() : undefined);
    const result = await f.service.switch(ROW.id, EXTRA);
    expect(result.ok).toBe(false);
    expect(result.panes[0]!.outcome).toBe("restarted");
    expect(result.error).toContain("future panes");
    expect((await f.service.view(ROW.id)).currentAccountId).toBe(EXTRA);
  });
});
