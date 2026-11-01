import type { Database } from "bun:sqlite";
import { AGENT_RUNTIMES } from "./agents";
import type { CodexAccounts, CodexAccountView } from "./codexAccounts";
import { CODEX_PROFILE_ROOT } from "./codexAccountProfiles";
import { getSession, logEvent, type SessionRow } from "./db";
import {
  agentProcsUnder, PANES_CMD, parsePanes, parseProcTree, PS_TREE_CMD, waitForProcs,
  type ExecResult, type Pane, type Proc, type RestartDeps,
} from "./ccUpkeep";
import { singleQuote } from "./tmux";
import { CodexConversation } from "./codexConversation";
import { beginCodexRemoteLaunch } from "./codexRemoteLaunch";

const DEFAULT_HOME = "/home/dev/.codex";
const ACCOUNT_ID = /^(?:default|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const validAccountId = (id: unknown): id is string => typeof id === "string" && ACCOUNT_ID.exec(id)?.[0] === id;
const good = (r: ExecResult) => r.code === 0 && !r.timedOut;

export class CodexSessionAccountError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 | 502 = 400) { super(message); }
}

export interface CodexSessionAccountsDeps extends RestartDeps {
  db: Database;
  accounts: Pick<CodexAccounts, "list">;
  inFlight: Set<string>;
  now: () => number;
  /** Recreate an idle container so newly added account volumes are mounted. */
  repairAccountMounts?: (sessionId: string) => Promise<boolean>;
}
export interface CodexSessionAccountView {
  accounts: (CodexAccountView & { available: boolean; unavailableReason: string | null })[];
  panes: { target: string; accountId: string | null; pending?: { accountId: string; threadId: string | null; phase: ContinuationPending["phase"] } }[];
  currentAccountId: string | null;
}
export interface CodexSessionAccountSwitchResult {
  ok: boolean; accountId: string; label: string; unchanged: boolean;
  panes: { target: string; outcome: string; threadId?: string }[];
  error?: string;
}
interface LivePane { pane: Pane; proc: Proc; accountId: string | null; resumeThreadId: string | null }
const accountHome = (id: string) => id === "default" ? DEFAULT_HOME : `${CODEX_PROFILE_ROOT}/${id}`;
interface ContinuationPending {
  version: 1; sourceAccountId: string; targetAccountId: string;
  threadId: string | null; cwd: string | null; empty?: true; freshThreadId?: string; phase: "identify" | "transfer" | "resume";
  /** The switch interrupted a goal in progress; resume it with the conversation. */
  resumeGoal?: true;
}
interface PendingPane { pane: Pane; pending: ContinuationPending }
const CONTINUATION_OPTION = "@devd_codex_continuation";
const PENDING_PANES_CMD = ["tmux", "list-panes", "-a", "-F", `#{session_name}:#{window_index}.#{pane_index}\t#{pane_pid}\t#{${CONTINUATION_OPTION}}`];
const safeCwd = (value: unknown): value is string => typeof value === "string" && value !== "/" && value.startsWith("/") && !/[\x00-\x1f\x7f]/.test(value);

// Only selected, non-secret environment keys leave the container. In particular,
// a stale tmux @devd_codex_account option is never proof of a running account.
const PROCESS_ACCOUNT_PROBE = `# CODEX_PROCESS_ACCOUNT_PROBE
import json, sys
from pathlib import Path
env = dict(part.split(b"=", 1) for part in Path("/proc/" + sys.argv[1] + "/environ").read_bytes().split(b"\\0") if b"=" in part)
result = {key: env[key.encode()].decode() if key.encode() in env else None for key in ("CODEX_HOME", "HOME", "CODEX_SQLITE_HOME", "DEVD_CODEX_REMOTE", "DEVD_CODEX_SHARED_HOME")}
args = Path("/proc/" + sys.argv[1] + "/cmdline").read_bytes().split(b"\\0")
resume = args.index(b"resume") if b"resume" in args else -1
result["resumeThreadId"] = args[resume + 1].decode() if resume >= 0 and resume + 1 < len(args) else None
print(json.dumps(result))
`;

// Check actual mounts, not merely directories: launching against an empty local
// directory would otherwise silently create a different profile. Never print
// credentials, even when the JSON is malformed or a file cannot be read.
const ACCOUNT_PREFLIGHT = `# CODEX_SESSION_ACCOUNT_PREFLIGHT
import json, os, re, sys
from pathlib import Path
mounts = set()
for line in Path("/proc/self/mountinfo").read_text().splitlines():
    path = line.split()[4]
    mounts.add(re.sub(r"\\\\([0-7]{3})", lambda m: chr(int(m[1], 8)), path))
launcher = os.access("/usr/local/bin/codex-account-env.sh", os.R_OK) and os.access("/usr/local/bin/co", os.X_OK)
result = {}
for account in json.loads(sys.argv[1]):
    path = Path("${DEFAULT_HOME}" if account == "default" else "${CODEX_PROFILE_ROOT}/" + account)
    reason = None
    if not launcher:
        reason = "This session needs an updated Codex account launcher."
    elif str(path) not in mounts or path.is_symlink() or str(path.resolve()) != str(path):
        reason = "This account is not mounted in this session. Recreate this session after finishing your work."
    else:
        try:
            auth = json.loads((path / "auth.json").read_text())
            tokens = auth.get("tokens") if isinstance(auth, dict) else None
            if not isinstance(tokens, dict) or not all(isinstance(tokens.get(k), str) and tokens[k] for k in ("access_token", "account_id")):
                reason = "Sign in to this ChatGPT account first."
        except (OSError, ValueError):
            reason = "The account credentials cannot be read. Sign in to this account first."
    result[account] = reason
print(json.dumps(result))
`;

function accountFromEnvironment(raw: string): string | null {
  const env = JSON.parse(raw) as Record<string, unknown>;
  const home = env.CODEX_HOME ?? (env.HOME === "/home/dev" ? DEFAULT_HOME : null);
  if (env.DEVD_CODEX_SHARED_HOME != null && env.DEVD_CODEX_SHARED_HOME !== DEFAULT_HOME) return null;
  if (home === DEFAULT_HOME) {
    if (env.CODEX_SQLITE_HOME != null && env.CODEX_SQLITE_HOME !== DEFAULT_HOME) return null;
    if (env.DEVD_CODEX_REMOTE != null && env.DEVD_CODEX_REMOTE !== "1") return null;
    return "default";
  }
  if (typeof home !== "string" || !home.startsWith(`${CODEX_PROFILE_ROOT}/`)) return null;
  // The secondary account must own its SQLite/writer state and must never attach
  // to the default account's central Remote server.
  if (env.CODEX_SQLITE_HOME !== home || env.DEVD_CODEX_REMOTE !== "0") return null;
  const id = home.slice(CODEX_PROFILE_ROOT.length + 1);
  return id !== "default" && validAccountId(id) ? id : null;
}

function accountUnavailable(account: CodexAccountView): string | null {
  if (account.disabled) return "Enable this account in Subscriptions first.";
  if (account.usage?.state === "signed-out"
    || (account.usage?.state === "error" && /HTTP (401|402|403)|deactivated|invalid_grant/i.test(account.usage.error ?? "")))
    return "Sign in to this ChatGPT account first.";
  return null;
}

export class CodexSessionAccounts {
  private conversation: CodexConversation;
  constructor(private d: CodexSessionAccountsDeps) { this.conversation = new CodexConversation(d); }

  private session(id: string): SessionRow {
    const session = getSession(this.d.db, id);
    if (!session) throw new CodexSessionAccountError("Unknown session.", 404);
    if (session.status !== "running") throw new CodexSessionAccountError("Start the session before changing its Codex account.", 409);
    if (session.agent !== "codex") throw new CodexSessionAccountError("Account switching is available for native Codex sessions only.", 409);
    return session;
  }

  private async livePanes(container: string): Promise<LivePane[]> {
    try {
      const results = await Promise.allSettled([
        this.d.exec(container, PANES_CMD, 15_000), this.d.exec(container, PS_TREE_CMD, 15_000),
      ]);
      const [list, ps] = results.map(r => {
        if (r.status !== "fulfilled" || !good(r.value)) throw new Error("probe failed");
        return r.value.stdout;
      });
      const panes = parsePanes(list!);
      const procs = parseProcTree(ps!);
      if (panes.length !== list!.split("\n").filter(l => l.trim()).length
        || procs.length !== ps!.split("\n").filter(l => l.trim()).length || !procs.length)
        throw new Error("invalid process probe");
      const live: LivePane[] = [];
      for (const pane of panes) {
        // agentProcsUnder is breadth-first, so a nested Codex subagent cannot
        // override the account of the TUI nearest the pane shell.
        const proc = agentProcsUnder(pane.pid, procs, AGENT_RUNTIMES)[0];
        if (!proc || proc.comm !== "codex") continue;
        const env = await this.d.exec(container, ["python3", "-c", PROCESS_ACCOUNT_PROBE, String(proc.pid)], 10_000);
        if (!good(env)) throw new Error("unreadable process environment");
        const resumed = JSON.parse(env.stdout).resumeThreadId;
        live.push({ pane, proc, accountId: accountFromEnvironment(env.stdout),
          resumeThreadId: typeof resumed === "string" && resumed !== "default" && validAccountId(resumed) ? resumed : null,
        });
      }
      return live;
    } catch { throw new CodexSessionAccountError("Could not read the running Codex accounts. No account change was confirmed.", 502); }
  }

  private async availability(container: string, accounts: CodexAccountView[]) {
    try {
      if (accounts.some(a => !validAccountId(a.id))) throw new Error("invalid catalog");
      const result = await this.d.exec(container, ["python3", "-c", ACCOUNT_PREFLIGHT, JSON.stringify(accounts.map(a => a.id))], 15_000);
      if (!good(result)) throw new Error("preflight failed");
      const reasons = JSON.parse(result.stdout) as Record<string, unknown>;
      return accounts.map(account => {
        if (!(account.id in reasons) || !(reasons[account.id] === null || typeof reasons[account.id] === "string"))
          throw new Error("invalid preflight");
        const unavailableReason = accountUnavailable(account) ?? reasons[account.id] as string | null;
        return { ...account, available: unavailableReason === null, unavailableReason };
      });
    } catch { throw new CodexSessionAccountError("Could not check the account mounts and credentials. The running Codex panes were left unchanged.", 502); }
  }

  private async pendingPanes(container: string): Promise<PendingPane[]> {
    try {
      const result = await this.d.exec(container, PENDING_PANES_CMD, 15_000);
      if (!good(result)) throw new Error("unreadable recovery state");
      const rows = result.stdout.split("\n").filter(line => line.trim());
      if (parsePanes(result.stdout).length !== rows.length) throw new Error("invalid pane list");
      return rows.flatMap(line => {
        const fields = line.split("\t");
        if (!fields[2]) return [];
        const pending = JSON.parse(fields.slice(2).join("\t")) as ContinuationPending;
        if (pending.version !== 1 || !validAccountId(pending.sourceAccountId) || !validAccountId(pending.targetAccountId)
          || !["identify", "transfer", "resume"].includes(pending.phase)
          || (pending.threadId !== null && (typeof pending.threadId !== "string" || pending.threadId === "default" || !validAccountId(pending.threadId)))
          || (pending.empty !== undefined && pending.empty !== true)
          || (pending.resumeGoal !== undefined && pending.resumeGoal !== true)
          || (pending.freshThreadId !== undefined && (!pending.empty || !validAccountId(pending.freshThreadId) || pending.freshThreadId === "default"))
          || (pending.cwd !== null && !safeCwd(pending.cwd))
          || (pending.phase !== "identify" && pending.threadId === null)
          || (pending.phase === "resume" && pending.cwd === null)) throw new Error("invalid continuation state");
        return [{ pane: parsePanes(line)[0]!, pending }];
      });
    } catch { throw new CodexSessionAccountError("Could not read pending Codex continuations. No whole-session success can be confirmed.", 502); }
  }

  private async remember(container: string, pane: Pane, pending: ContinuationPending | null): Promise<void> {
    const command = pending
      ? ["tmux", "set-option", "-p", "-t", pane.target, CONTINUATION_OPTION, JSON.stringify(pending)]
      : ["tmux", "set-option", "-p", "-u", "-t", pane.target, CONTINUATION_OPTION];
    if (!good(await this.d.exec(container, command, 10_000))) throw new Error("Could not persist continuation recovery state");
  }

  private async requireShell(container: string, pane: Pane): Promise<void> {
    const [list, ps] = await Promise.all([
      this.d.exec(container, PANES_CMD, 15_000), this.d.exec(container, PS_TREE_CMD, 15_000),
    ]);
    if (!good(list) || !good(ps)) throw new Error("Could not verify the launch pane");
    const listed = parsePanes(list.stdout);
    const processes = parseProcTree(ps.stdout);
    const shells = ["sh", "bash", "zsh", "fish", "dash", "ksh"];
    const branch = agentProcsUnder(pane.pid, processes, processes.map(p => p.comm));
    if (listed.length !== list.stdout.split("\n").filter(line => line.trim()).length
      || processes.length !== ps.stdout.split("\n").filter(line => line.trim()).length
      || !listed.some(p => p.target === pane.target && p.pid === pane.pid)
      || !processes.some(p => p.pid === pane.pid && shells.includes(p.comm))
      || branch.some(p => !shells.includes(p.comm)))
      throw new Error("The pane changed while its conversation was being transferred");
  }

  // A resume can succeed after the switch gave up verifying it (e.g. a slow
  // start). Clear such recovery state once the pane provably runs the target
  // account on the expected conversation. Read-only probes only: this runs on
  // every view, so it must never type into the user's pane.
  private async settleResumed(sessionId: string, container: string, live: LivePane[], pending: PendingPane[]): Promise<PendingPane[]> {
    if (this.d.inFlight.has(sessionId) || !pending.some(p => p.pending.phase === "resume")) return pending;
    this.d.inFlight.add(sessionId);
    try {
      const remaining: PendingPane[] = [];
      for (const item of pending) {
        const state = item.pending;
        const active = live.find(p => p.pane.target === item.pane.target && p.pane.pid === item.pane.pid);
        const expected = state.empty ? state.freshThreadId : state.threadId;
        const settled = state.phase === "resume" && !!expected && active?.accountId === state.targetAccountId
          && (state.empty || active.resumeThreadId === expected)
          && await this.conversation.verify(container, accountHome(state.targetAccountId), expected, active.proc.pid, false, !!state.empty)
            .catch(() => false)
          && (state.targetAccountId !== "default" || !!state.empty
            || await this.conversation.grantFullAccess(container, accountHome(state.targetAccountId), expected).then(() => true, () => false));
        if (settled) {
          try { await this.remember(container, item.pane, null); continue; } catch { /* keep it visible */ }
        }
        remaining.push(item);
      }
      if (!remaining.length && live[0]?.accountId && live.every(p => p.accountId === live[0]!.accountId))
        await this.d.exec(container, ["tmux", "set-environment", "-g", "DEVD_CODEX_ACCOUNT_ID", live[0].accountId], 10_000).catch(() => {});
      return remaining;
    } finally { this.d.inFlight.delete(sessionId); }
  }

  async view(sessionId: string): Promise<CodexSessionAccountView> {
    const session = this.session(sessionId);
    let live = await this.livePanes(session.container);
    let pending = await this.settleResumed(sessionId, session.container, live, await this.pendingPanes(session.container));
    const idle = !live.length && !pending.length;
    if (idle) await this.d.repairAccountMounts?.(sessionId);
    const accounts = await this.availability(session.container, this.d.accounts.list().accounts);
    if (idle) {
      live = await this.livePanes(session.container);
      pending = await this.pendingPanes(session.container);
    }
    const unavailable = !live.length && !pending.length ? "There is no running Codex pane in this session. Start Codex in Terminal first."
      : live.some(p => p.accountId === null) ? "The running Codex account could not be identified." : null;
    const targets = [...new Set([...live.map(p => p.pane.target), ...pending.map(p => p.pane.target)])];
    return {
      accounts: accounts.map(account => {
        const reason = account.unavailableReason ?? unavailable
          ?? (pending.some(p => p.pending.targetAccountId !== account.id) ? "Finish the pending conversation switch with its selected account first." : null);
        return { ...account, available: reason === null, unavailableReason: reason };
      }),
      panes: targets.map(target => {
        const recovery = pending.find(p => p.pane.target === target)?.pending;
        return { target, accountId: live.find(p => p.pane.target === target)?.accountId ?? null,
          ...(recovery ? { pending: { accountId: recovery.targetAccountId, threadId: recovery.threadId, phase: recovery.phase } } : {}),
        };
      }),
      currentAccountId: !pending.length && live.length && live.every(p => p.accountId === live[0]!.accountId) ? live[0]!.accountId : null,
    };
  }

  async switch(sessionId: string, accountId: unknown): Promise<CodexSessionAccountSwitchResult> {
    if (typeof accountId !== "string" || !validAccountId(accountId))
      throw new CodexSessionAccountError("Select a valid Codex account.");
    const session = this.session(sessionId);
    const selected = this.d.accounts.list().accounts.find(a => a.id === accountId);
    if (!selected) throw new CodexSessionAccountError("Unknown or not yet signed-in Codex account.", 404);
    if (this.d.inFlight.has(sessionId)) throw new CodexSessionAccountError("This session is busy with another lifecycle operation. Try again shortly.", 409);
    this.d.inFlight.add(sessionId);
    let finishRemoteLaunch = () => {};
    try {
      let live = await this.livePanes(session.container);
      let pending = await this.pendingPanes(session.container);
      const idle = !live.length && !pending.length;
      if (idle) await this.d.repairAccountMounts?.(sessionId);
      const [account] = await this.availability(session.container, [selected]);
      if (!account!.available) throw new CodexSessionAccountError(account!.unavailableReason!, 409);
      if (idle) {
        live = await this.livePanes(session.container);
        pending = await this.pendingPanes(session.container);
      }
      if (!live.length && !pending.length) throw new CodexSessionAccountError("There is no running Codex pane in this session. Start Codex in Terminal first.", 409);
      if (live.some(p => p.accountId === null)) throw new CodexSessionAccountError("The running Codex account could not be identified. The panes were left unchanged.", 502);
      if (pending.some(p => p.pending.targetAccountId !== accountId)) throw new CodexSessionAccountError("Finish the pending continuation with its selected account first.", 409);
      type Work = { pane: Pane; pending?: ContinuationPending; outcome?: string; previousPid?: number };
      const work: Work[] = [...new Set([...live.map(p => p.pane.target), ...pending.map(p => p.pane.target)])].map(target => ({
        pane: pending.find(p => p.pane.target === target)?.pane ?? live.find(p => p.pane.target === target)!.pane,
        pending: pending.find(p => p.pane.target === target)?.pending,
      }));

      const result: CodexSessionAccountSwitchResult = { ok: false, accountId, label: selected.label, unchanged: true, panes: [] };
      const prefix = `unset CODEX_SQLITE_HOME DEVD_CODEX_SHARED_HOME DEVD_CODEX_REMOTE; export CODEX_HOME=${singleQuote(DEFAULT_HOME)} DEVD_CODEX_ACCOUNT_ID=${singleQuote(accountId)}; `;
      if (accountId !== "default" && work.length > 1 && (pending.length || live.some(p => p.accountId !== accountId))) {
        const observed = new Map<string, string>();
        try {
          for (const item of work) {
            const current = live.find(p => p.pane.target === item.pane.target && p.pane.pid === item.pane.pid);
            const id = current ? await this.conversation.current(session.container, item.pane, current.proc.pid) : item.pending?.threadId;
            if (!id) throw new Error("Cannot identify every view before switching");
            observed.set(item.pane.target, id);
          }
          if (new Set(observed.values()).size !== observed.size) {
            result.panes = work.map(item => ({ target: item.pane.target, outcome: "duplicate-conversation-view", threadId: observed.get(item.pane.target)! }));
            result.error = "Close duplicate views of this conversation, then retry. This account can have one active writer for each conversation.";
            return result;
          }
        } catch {
          result.panes = work.map(item => ({ target: item.pane.target, outcome: "conversation-not-verified" }));
          result.error = "Could not identify every current conversation. The Codex panes were left running; no conversation was transferred.";
          return result;
        }
      }
      // Stop every source TUI before archiving any thread: two panes can display
      // the same UUID, and archive is a shared writer boundary for that thread.
      for (const item of work) {
        try {
          const fresh = (await this.livePanes(session.container)).find(p => p.pane.target === item.pane.target && p.pane.pid === item.pane.pid);
          if (!item.pending && fresh?.accountId === accountId) { item.outcome = "already-on-account"; continue; }
          if (item.pending?.phase === "resume") continue;
          if (item.pending?.phase === "transfer") {
            await this.requireShell(session.container, item.pane);
            continue;
          }
          if (!fresh?.accountId || (item.pending && fresh.accountId !== item.pending.sourceAccountId)) throw new Error("Source conversation is not running or its identity is unknown");
          result.unchanged = false;
          item.previousPid = fresh.proc.pid;
          if (!item.pending) {
            item.pending = { version: 1, sourceAccountId: fresh.accountId, targetAccountId: accountId, threadId: null, cwd: null, phase: "identify" };
            await this.remember(session.container, item.pane, item.pending);
          }
          const { threadId, resumeGoal } = await this.conversation.stop(session.container, fresh.pane, fresh.proc.pid);
          item.pending = { ...item.pending, threadId, phase: "transfer", ...(resumeGoal ? { resumeGoal: true as const } : {}) };
          await this.remember(session.container, item.pane, item.pending);
        } catch { item.outcome = "conversation-transfer-failed"; }
      }
      const stopFailed = work.some(item => item.outcome === "conversation-transfer-failed");
      if (accountId !== "default") {
        const ready = work.filter(item => !item.outcome && item.pending?.phase === "transfer");
        if (new Set(ready.map(item => item.pending!.threadId)).size !== ready.length) {
          for (const item of ready) item.outcome = "duplicate-conversation-view";
          result.error = "Close duplicate views of this conversation, then retry. The exact source conversations are retained for recovery.";
        }
      }
      const transfers = new Map<string, { cwd: string; empty?: boolean }>();
      const protectedThreads: string[] = [];
      if (!stopFailed && work.some(item => !item.outcome && item.pending?.phase === "transfer")) {
        try {
          for (const item of work.filter(item => item.outcome === "already-on-account")) {
            const active = (await this.livePanes(session.container)).find(p => p.pane.target === item.pane.target && p.pane.pid === item.pane.pid);
            if (!active || active.accountId !== accountId) throw new Error("Target pane changed before transfer");
            protectedThreads.push(await this.conversation.current(session.container, item.pane, active.proc.pid));
          }
        } catch {
          for (const item of work.filter(item => !item.outcome && item.pending?.phase === "transfer")) item.outcome = "conversation-transfer-pending";
        }
      }
      for (const item of work.filter(item => !item.outcome && item.pending?.phase === "transfer")) {
        if (stopFailed) { item.outcome = "conversation-transfer-pending"; continue; }
        const state = item.pending!;
        const key = `${state.sourceAccountId}:${state.targetAccountId}:${state.threadId}`;
        try {
          if (protectedThreads.includes(state.threadId!)) throw new Error("The target account is already using this conversation in another pane");
          const transferred = transfers.get(key) ?? await this.conversation.transfer(session.container, accountHome(state.sourceAccountId), accountHome(accountId), state.threadId!, protectedThreads);
          transfers.set(key, transferred);
          item.pending = { ...state, phase: "resume", cwd: transferred.cwd, ...(transferred.empty ? { empty: true as const } : {}) };
          await this.remember(session.container, item.pane, item.pending);
        } catch { item.outcome = "conversation-transfer-failed"; }
      }
      const resumable = work.filter(item => !item.outcome && item.pending?.phase === "resume");
      if (accountId === "default" && resumable.length) finishRemoteLaunch = beginCodexRemoteLaunch(this.d.inFlight, sessionId);
      for (const item of resumable) {
        const state = item.pending!;
        result.unchanged = false;
        try {
          let active = (await this.livePanes(session.container)).find(p => p.pane.target === item.pane.target && p.pane.pid === item.pane.pid);
          if (!active) {
            await this.requireShell(session.container, item.pane);
            // This is the same verified conversation/workspace the user chose
            // to continue. Scope trust to this invocation and exact directory;
            // a fresh isolated home otherwise interrupts resume with onboarding.
            // Codex splits override keys on literal dots; quoted path keys
            // must therefore live in the TOML value, not the override key.
            const trust = accountId === "default" ? "" : ` -c ${singleQuote(`projects={${JSON.stringify(state.cwd!)}={trust_level="trusted"}}`)}`;
            const resume = state.empty && !state.freshThreadId ? "" : ` resume ${state.freshThreadId ?? state.threadId}`;
            const launch = `${prefix}/usr/local/bin/co -C ${singleQuote(state.cwd!)}${trust}${resume}`;
            const sent = await this.d.exec(session.container, ["tmux", "send-keys", "-t", item.pane.target, launch, "Enter"], 10_000);
            if (!good(sent) || !await waitForProcs(this.d, session.container, item.pane.pid, ["codex"], true, 60_000)) {
              item.outcome = "did-not-return";
              continue;
            }
            active = (await this.livePanes(session.container)).find(p => p.pane.target === item.pane.target && p.pane.pid === item.pane.pid);
            if (active) await this.conversation.settleGoalPrompt(session.container, item.pane, active.proc.pid, !!state.resumeGoal).catch(() => {});
          }
          if (!active || active.accountId !== accountId || active.proc.pid === item.previousPid) item.outcome = "account-not-verified";
          else if (!state.empty && (active.resumeThreadId !== state.threadId
            || !await this.conversation.verify(session.container, accountHome(accountId), state.threadId!, active.proc.pid, true)))
            item.outcome = "conversation-not-verified";
          else {
            // A verified empty source has no history/UUID to resume. Bind the
            // replacement to its freshly observed UUID before claiming success.
            const current = await this.conversation.current(session.container, item.pane, active.proc.pid);
            if (state.empty && !state.freshThreadId) {
              state.freshThreadId = current;
              item.pending = { ...state };
              await this.remember(session.container, item.pane, item.pending);
            }
            const expected = state.freshThreadId ?? state.threadId!;
            if ((!state.empty && active.resumeThreadId !== expected) || current !== expected
              || (state.empty && !await this.conversation.verify(session.container, accountHome(accountId), expected, active.proc.pid, true, true)))
              item.outcome = "conversation-not-verified";
            else {
              // Only a resume onto the central server needs this; a fresh empty
              // launch already starts with the devbox full-access flags.
              if (accountId === "default" && !state.empty) {
                try { await this.conversation.grantFullAccess(session.container, accountHome(accountId), expected); }
                catch { item.outcome = "permissions-not-restored"; continue; }
              }
              item.outcome = "restarted";
            }
          }
        } catch { item.outcome = "conversation-transfer-failed"; }
      }
      result.panes = work.map(item => ({ target: item.pane.target, outcome: item.outcome ?? "conversation-transfer-failed",
        ...(item.pending?.threadId ? { threadId: item.pending.freshThreadId ?? item.pending.threadId } : {}),
      }));
      if (result.panes.every(p => p.outcome === "restarted" || p.outcome === "already-on-account")) {
        try {
          const actual = await this.livePanes(session.container);
          // A new pane opened during the operation must agree too; otherwise the
          // session is mixed and the requested whole-session result is incomplete.
          if ((await this.pendingPanes(session.container)).some(p => !work.some(w => w.pane.target === p.pane.target && w.pending?.threadId === p.pending.threadId))
            || !work.every(p => actual.some(a => a.pane.target === p.pane.target && a.pane.pid === p.pane.pid))
            || actual.some(p => p.accountId !== accountId)) throw new Error("account changed during switch");
          for (const pane of result.panes.filter(p => p.threadId)) {
            const active = actual.find(p => p.pane.target === pane.target)!;
            const empty = work.find(w => w.pane.target === pane.target)?.pending?.empty;
            if ((!empty && active.resumeThreadId !== pane.threadId) || !await this.conversation.verify(session.container, accountHome(accountId), pane.threadId!, active.proc.pid, false, !!empty)
              || await this.conversation.current(session.container, active.pane, active.proc.pid) !== pane.threadId)
              throw new Error("conversation changed during switch");
          }
          for (const item of work.filter(item => item.pending)) await this.remember(session.container, item.pane, null);
          if ((await this.pendingPanes(session.container)).length) throw new Error("Unresolved continuation remains");
          const remembered = await this.d.exec(session.container, ["tmux", "set-environment", "-g", "DEVD_CODEX_ACCOUNT_ID", accountId], 10_000);
          if (!good(remembered)) throw new Error("tmux environment failed");
          result.ok = true;
        } catch { result.error = "The panes were processed, but the final account state or selection for future panes could not be confirmed. Refresh to see the current accounts."; }
      } else {
        for (const item of work.filter(item => item.outcome === "restarted")) {
          try { await this.remember(session.container, item.pane, null); } catch { /* keep recovery visible until its metadata can be cleared */ }
        }
        result.error ??= "Some Codex conversations could not be safely continued. Existing conversation history was preserved. Successfully switched panes keep their resumed conversation and new account; refresh to see the current accounts.";
      }
      // An unavailable event log must not discard the observed partial outcome.
      try { logEvent(this.d.db, sessionId, "codex_account_switch", {
        accountId, ok: result.ok, panes: result.panes, at: this.d.now(),
      }); } catch { /* the returned pane outcomes remain authoritative */ }
      return result;
    } finally { finishRemoteLaunch(); this.d.inFlight.delete(sessionId); }
  }
}
