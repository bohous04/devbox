import { expect, test } from "bun:test";
import { CodexSessionAccounts } from "../src/codexSessionAccounts";
import type { CodexAccountView } from "../src/codexAccounts";
import type { ExecResult } from "../src/ccUpkeep";
import { insertSession, openDb } from "../src/db";

const ACCOUNT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const IDS = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
const OTHER = "33333333-3333-4333-8333-333333333333";
const SESSION = "dev-review-recovery";
const home = (account: string) => account === "default" ? "/home/dev/.codex" : `/home/dev/.codex-accounts/${account}`;
const ok = (value = ""): ExecResult => ({ code: 0, stdout: value, stderr: "", timedOut: false });
const fail = (): ExecResult => ({ code: 1, stdout: "", stderr: "fixture failure", timedOut: false });

function fixture(count = 1) {
  const db = openDb(":memory:");
  insertSession(db, { id: SESSION, container: SESSION, folder: "fixture", project: "review", repo: "recovery", port_base: 40100, status: "running", solo: 0, agent: "codex", created_at: 0, last_active_at: 0, important: 0 });
  const accounts: CodexAccountView[] = ["default", ACCOUNT].map(id => ({ id, label: id, isDefault: id === "default", disabled: false, usage: null, sharedUsageWith: [] }));
  const panes = IDS.slice(0, count).map((threadId, i) => ({ target: `main:${i}.0`, root: 100 + i * 10, pid: 101 + i * 10, account: "default", alive: true, threadId, resumeId: null as string | null, pending: "", quitPending: false, statusPending: false, writerReady: true }));
  const calls: string[][] = [];
  const failedStarts = new Set<string>();
  const extraProcesses: string[] = [];
  let nextPid = 500;
  let afterTransfer: (() => void) | undefined;
  let afterStart: (() => void) | undefined;
  let afterCapture: (() => void) | undefined;
  const d = {
    db, accounts: { list: () => ({ accounts, preferredAccountId: null }) }, inFlight: new Set<string>(), now: () => 123, sleep: async (_ms: number) => {},
    exec: async (_container: string, cmd: string[]): Promise<ExecResult> => {
      calls.push(cmd);
      if (cmd[0] === "tmux" && cmd[1] === "list-panes") {
        const withPending = cmd.some(arg => arg.includes("@devd_codex_continuation"));
        return ok(panes.map(p => `${p.target}\t${p.root}${withPending ? `\t${p.pending}` : ""}`).join("\n"));
      }
      if (cmd[0] === "ps") return ok(panes.map(p => `${p.root} 1 900 zsh\n${p.alive ? `${p.pid} ${p.root} 100 codex\n` : ""}`).join("") + extraProcesses.join("\n"));
      if (cmd[0] === "python3" && cmd[2]?.includes("CODEX_SESSION_ACCOUNT_PREFLIGHT")) return ok(JSON.stringify(Object.fromEntries(accounts.map(a => [a.id, null]))));
      if (cmd[0] === "python3" && cmd[2]?.includes("CODEX_PROCESS_ACCOUNT_PROBE")) {
        const p = panes.find(p => p.alive && String(p.pid) === cmd[3]);
        if (!p) return fail();
        return ok(JSON.stringify({ CODEX_HOME: home(p.account), HOME: "/home/dev", CODEX_SQLITE_HOME: p.account === "default" ? null : home(p.account), DEVD_CODEX_REMOTE: p.account === "default" ? null : "0", resumeThreadId: p.resumeId }));
      }
      if (cmd[0] === "python3" && cmd[2]?.includes("CODEX_EXIT_CAPTURE")) {
        if (cmd[3] === "begin") { afterCapture?.(); return ok('{"capture":"/tmp/devd-codex-continuation-recovery"}'); }
        if (cmd[3] === "finish" || cmd[3] === "peek-status") return ok(JSON.stringify({ threadId: panes.find(p => p.target === cmd[4])?.threadId }));
        return ok('{"ok":true}');
      }
      if (cmd[0] === "python3" && cmd[3] === "transfer") {
        afterTransfer?.();
        return ok(JSON.stringify({ ok: true, threadId: cmd[cmd.indexOf("--thread-id") + 1], cwd: "/workspace/review-recovery" }));
      }
      if (cmd[0] === "python3" && cmd[3] === "verify") {
        const id = cmd[cmd.indexOf("--thread-id") + 1];
        const p = panes.find(p => p.alive && String(p.pid) === cmd[cmd.indexOf("--writer-pid") + 1]);
        return p?.writerReady && p.threadId === id ? ok(JSON.stringify({ ok: true, threadId: id })) : fail();
      }
      if (cmd[0] === "tmux" && cmd[1] === "set-option" && cmd.includes("@devd_codex_continuation")) {
        const p = panes.find(p => p.target === cmd[cmd.indexOf("-t") + 1]);
        if (!p) return fail();
        p.pending = cmd.some(a => /^-[^-]*u/.test(a)) ? "" : cmd[cmd.indexOf("@devd_codex_continuation") + 1] ?? "";
        return ok();
      }
      if (cmd[0] === "tmux" && cmd[1] === "send-keys") {
        const p = panes.find(p => p.target === cmd[cmd.indexOf("-t") + 1]);
        if (!p) return fail();
        if (cmd.includes("/status")) { p.statusPending = true; return ok(); }
        if (cmd[4] === "Enter" && p.statusPending) { p.statusPending = false; return ok(); }
        if (cmd.includes("/quit")) { p.quitPending = true; return ok(); }
        if (cmd[4] === "Enter" && p.quitPending) { p.quitPending = false; p.alive = false; return ok(); }
        if (failedStarts.has(p.target)) return fail();
        const account = cmd[4]?.match(/DEVD_CODEX_ACCOUNT_ID='([^']+)'/)?.[1];
        const id = cmd[4]?.match(/\/usr\/local\/bin\/co\b.*?\bresume ([0-9a-f-]+)/)?.[1];
        if (!account || !id) throw new Error("Unexpected command injected into pane");
        p.account = account; p.resumeId = id; p.threadId = id; p.pid = nextPid++; p.alive = true;
        afterStart?.();
        return ok();
      }
      if (cmd[0] === "tmux" && cmd[1] === "set-environment") return ok();
      if (cmd[0] === "tmux" && cmd[1] === "capture-pane") return ok("› Ask Codex to do anything\n  ? for shortcuts");
      throw new Error(`Unexpected fixture command: ${JSON.stringify(cmd)}`);
    },
  };
  return { service: new CodexSessionAccounts(d), panes, calls, failedStarts, extraProcesses,
    afterTransfer: (f: () => void) => { afterTransfer = f; }, afterStart: (f: () => void) => { afterStart = f; },
    afterCapture: (f: () => void) => { afterCapture = f; },
    starts: () => calls.filter(c => c[1] === "send-keys" && /\/usr\/local\/bin\/co\b.*?\bresume /.test(c[4] ?? "")),
    transfers: () => calls.filter(c => c[0] === "python3" && c[3] === "transfer"),
  };
}

test("retry recovers a stopped second pane rather than declaring only the healthy first pane successful", async () => {
  const f = fixture(2); f.failedStarts.add(f.panes[1]!.target);
  expect((await f.service.switch(SESSION, ACCOUNT)).ok).toBe(false);
  expect(f.panes[0]!.alive).toBe(true); expect(f.panes[1]!.alive).toBe(false);
  const view = await f.service.view(SESSION);
  expect(view.currentAccountId).toBeNull();
  expect(view.panes.map(p => p.target)).toContain(f.panes[1]!.target);
  expect(f.panes[1]!.pending).toContain(IDS[1]!);
  f.failedStarts.clear();
  expect((await f.service.switch(SESSION, ACCOUNT)).ok).toBe(true);
  expect(f.panes.every(p => p.alive && p.account === ACCOUNT && p.pending === "")).toBe(true);
  expect(f.panes.map(p => p.threadId)).toEqual(IDS);
  expect(f.transfers()).toHaveLength(2); // The completed handoff is not repeated during retry.
});

test("a target-account process with failed writer verification is not an already-on-account success on retry", async () => {
  const f = fixture(); f.panes[0]!.writerReady = false;
  expect((await f.service.switch(SESSION, ACCOUNT)).ok).toBe(false);
  const count = f.starts().length;
  expect(f.panes[0]!.pending).toContain(IDS[0]!);
  expect((await f.service.switch(SESSION, ACCOUNT)).ok).toBe(false);
  expect(f.starts()).toHaveLength(count);
  f.panes[0]!.writerReady = true;
  expect((await f.service.switch(SESSION, ACCOUNT)).ok).toBe(true);
  expect(f.panes[0]!.pending).toBe("");
  expect(f.starts()).toHaveLength(count);
  expect(f.transfers()).toHaveLength(1);
});

test("stale resume argv after /new cannot clear a pending exact-conversation failure", async () => {
  const f = fixture(); f.afterStart(() => { f.panes[0]!.threadId = OTHER; });
  expect((await f.service.switch(SESSION, ACCOUNT)).ok).toBe(false);
  expect(f.panes[0]!.resumeId).toBe(IDS[0]!);
  expect(f.panes[0]!.threadId).toBe(OTHER);
  expect((await f.service.switch(SESSION, ACCOUNT)).ok).toBe(false);
  expect(f.panes[0]!.pending).toContain(IDS[0]!);
  expect(f.starts()).toHaveLength(1);
});

test("a human-started agent during transfer never receives the resume shell command", async () => {
  const f = fixture();
  f.afterTransfer(() => { const p = f.panes[0]!; p.alive = true; p.pid = 999; p.threadId = OTHER; });
  expect((await f.service.switch(SESSION, ACCOUNT)).ok).toBe(false);
  expect(f.starts()).toHaveLength(0);
  expect(f.panes[0]!.pid).toBe(999);
  expect(f.panes[0]!.threadId).toBe(OTHER);
});

test("a replacement tmux pane during transfer never receives the old pane's conversation", async () => {
  const f = fixture();
  f.afterTransfer(() => { const p = f.panes[0]!; p.root = 900; p.pid = 901; p.alive = false; p.pending = ""; });
  expect((await f.service.switch(SESSION, ACCOUNT)).ok).toBe(false);
  expect(f.starts()).toHaveLength(0);
});

test("a replacement Codex during output-capture setup does not receive the previous process's exit command", async () => {
  const f = fixture();
  f.afterCapture(() => { const p = f.panes[0]!; p.pid = 999; p.account = ACCOUNT; p.threadId = OTHER; });
  expect((await f.service.switch(SESSION, ACCOUNT)).ok).toBe(false);
  expect(f.calls.filter(c => c[1] === "send-keys")).toHaveLength(0);
  expect(f.transfers()).toHaveLength(0);
  expect(f.panes[0]!.alive).toBe(true);
  expect(f.panes[0]!.threadId).toBe(OTHER);
});

test("an already-target-account pane sharing the transferred UUID must be resumed too or rejected before transfer", async () => {
  const f = fixture(2);
  f.panes[1]!.account = ACCOUNT; f.panes[1]!.threadId = IDS[0]!; f.panes[1]!.resumeId = IDS[0]!;
  f.afterTransfer(() => { f.panes[1]!.writerReady = false; }); // Native target archive unloads this thread.
  f.afterStart(() => { for (const p of f.panes) if (p.pid >= 500) p.writerReady = true; });
  const result = await f.service.switch(SESSION, ACCOUNT);
  if (!result.ok) { expect(f.transfers()).toHaveLength(0); return; }
  expect(f.starts()).toHaveLength(2);
  expect(f.panes.every(p => p.alive && p.account === ACCOUNT && p.threadId === IDS[0] && p.writerReady)).toBe(true);
});

for (const foreground of ["vim", "python3"]) {
  test(`a human-started ${foreground} during transfer never receives a resume shell command`, async () => {
    const f = fixture();
    f.afterTransfer(() => { f.extraProcesses.push(`999 ${f.panes[0]!.root} 0 ${foreground}`); });
    expect((await f.service.switch(SESSION, ACCOUNT)).ok).toBe(false);
    expect(f.starts()).toHaveLength(0);
    expect(f.panes[0]!.pending).toContain(IDS[0]!);
    expect(f.extraProcesses).toHaveLength(1);
  });
}
