import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { BridgeCommand } from "../../image/agent-bridge/src/protocol";
import { PROXY_PROFILE_ENV_KEYS, PROXY_PROFILES, proxyProfileEnv } from "../../image/agent-bridge/src/proxyProfile";
import type { BridgeEvent, Capabilities } from "../../shared/thread";
import { PROFILE_ENV } from "../src/agentSwitch";
import { AgentDisconnected, CommandFailed } from "../src/bridgeLink";
import { CHAT_MODELS, ChatSwitch, MODEL_WINDOW_ALIASES, type ChatSwitchDeps } from "../src/chatSwitch";
import { PRICED_MODELS } from "../src/pricing";
import type { CodexAccountView } from "../src/codexAccounts";
import { ACCOUNT_POOL_DEFAULTS } from "../src/config";
import {
  getRepoAgent, getSession, insertAccount, insertLease, insertSession, leaseHistory, openDb, upsertAccountUsage,
  type AccountUsageRow, type SessionRow,
} from "../src/db";
import { EventBus } from "../src/eventBus";
import { registerThreadRoutes } from "../src/threadApi";
import { ThreadStore } from "../src/threadStore";
import { historyOmittedNotice } from "../src/transition";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const CLAUDE_CAPS: Capabilities = { resume: true, injectItems: false, liveModelSwitch: true, questions: true, images: true, backgroundVisibility: true };
const CODEX_CAPS: Capabilities = { resume: true, injectItems: true, liveModelSwitch: true, questions: true, images: true, backgroundVisibility: false };

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

const CHAT: SessionRow = {
  id: "dev-a-chat", folder: "acme", project: "a", repo: "chat", container: "dev-a-chat",
  port_base: 40100, status: "running", solo: 0, created_at: 0, last_active_at: 0, important: 0, agent: "claude", runtime: "chat",
};

const usage = (id: string, five: number, over: Partial<AccountUsageRow> = {}): AccountUsageRow => ({
  account_id: id, five_hour_pct: five, five_hour_resets_at: NOW + HOUR, seven_day_pct: 10, seven_day_resets_at: NOW + 10 * HOUR,
  limits_json: null, fetched_at: NOW, error: null, ...over,
});

const codexAccount = (id: string, over: Partial<CodexAccountView> = {}): CodexAccountView => ({
  id, label: id, isDefault: id === "default", disabled: false, sharedUsageWith: [],
  usage: { state: "ok", planType: "pro", windows: [{ usedPct: 10, resetsAt: NOW + HOUR } as never], credits: null, limitReached: null, fetchedAt: NOW, error: null },
  ...over,
});

const PROXY_INPUTS = { DEVD_UPSTREAM_URL: "http://proxy:8317", DEVD_UPSTREAM_KEY: "k-secret", DEVD_AGENT_MODEL: "gpt-x", DEVD_AGENT_CTX: "1000000" };

function setup(o: { agent?: SessionRow["agent"]; codex?: CodexAccountView[]; proxyInputs?: Record<string, string>; ensureProfile?: ChatSwitchDeps["ensureClaudeProfile"] } = {}) {
  const db = openDb(":memory:");
  insertSession(db, { ...CHAT, agent: o.agent ?? "claude" });
  insertAccount(db, { id: "primary", label: "primary", disabled: 0, quarantined_at: null, added_at: 1 });
  insertAccount(db, { id: "backup", label: "backup", disabled: 0, quarantined_at: null, added_at: 2 });
  insertAccount(db, { id: "jailed", label: "jailed", disabled: 0, quarantined_at: NOW - HOUR, added_at: 3 });
  insertAccount(db, { id: "full", label: "full", disabled: 0, quarantined_at: null, added_at: 4 });
  upsertAccountUsage(db, usage("primary", 30));
  upsertAccountUsage(db, usage("backup", 10));
  upsertAccountUsage(db, usage("jailed", 0));
  upsertAccountUsage(db, usage("full", 99));
  insertLease(db, { account_id: "primary", client: "devbox", session_id: CHAT.id, label: "a/chat", created_at: NOW - HOUR, released_at: null });

  const dir = mkdtempSync(join(tmpdir(), "chat-switch-"));
  const store = ThreadStore.open(dir, CHAT.id);
  cleanups.push(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

  const sent: BridgeCommand[] = [];
  /** Runs before a command resolves: may feed bridge events or throw the bridge's answer. */
  let onSend: (cmd: BridgeCommand) => void = () => {};
  const feed = (events: BridgeEvent[]) => {
    for (const event of events) {
      const e = { seq: store.lastSeq() + 1, ts: NOW, event };
      store.apply(e);
      sw.onEvent(CHAT.id, e);
    }
  };
  const codex = o.codex ?? [codexAccount("default"), codexAccount("c-two")];
  const deps: ChatSwitchDeps = {
    db,
    links: { send: async (_id, cmd) => { sent.push(cmd); onSend(cmd); } },
    threads: () => store,
    claudePool: () => ACCOUNT_POOL_DEFAULTS,
    codexAccounts: {
      list: () => ({ accounts: codex }),
      select: () => {
        const a = codex.find((x) => !x.disabled);
        if (!a) throw new Error("No enabled Codex account is available in this session.");
        return { accountId: a.id, label: a.label };
      },
    },
    ensureClaudeProfile: o.ensureProfile,
    proxyInputs: async () => o.proxyInputs ?? PROXY_INPUTS,
    now: () => NOW,
    log: () => {},
  };
  const sw = new ChatSwitch(deps);
  const app = new Hono();
  registerThreadRoutes(app, {
    db, mgr: { isEnding: () => false }, threads: () => store, bus: new EventBus(), inbox: { changedSafe: () => {} } as never,
    links: { send: deps.links.send, ensure: () => {}, startTurnWhenConnected: () => {} }, switcher: sw,
  });
  const post = async (what: string, body: unknown) => {
    const r = await app.fetch(new Request(`http://x/api/sessions/${CHAT.id}/thread/${what}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }));
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  return { db, store, sent, feed, post, sw, setOnSend: (f: (cmd: BridgeCommand) => void) => { onSend = f; } };
}

/** A Claude conversation of one completed turn on the `primary` account. */
function claudeThread(t: ReturnType<typeof setup>, account = "primary", model = "claude-opus-5-5") {
  t.feed([
    { type: "run.queued", runId: "r1", text: "Fix the login bug", attachments: [] },
    { type: "run.started", runId: "r1", origin: "user", nativeThreadId: null, model: null },
    { type: "thread.native", harness: "claude", nativeThreadId: "t-claude", account, model, caps: CLAUDE_CAPS },
    { type: "message.final", runId: "r1", itemId: "m1", role: "assistant", text: "Fixed it in auth.ts" },
    { type: "run.completed", runId: "r1", nativeThreadId: "t-claude", usage: null, costUsd: null },
  ]);
}

const activeLeases = (t: ReturnType<typeof setup>) => leaseHistory(t.db, "devbox", CHAT.id).filter((l) => l.released_at === null).map((l) => l.account_id);

// --- model ---

test("model: a live model switch sends setModel and answers 202 set-model", async () => {
  const t = setup();
  claudeThread(t);
  expect(await t.post("model", { model: "claude-sonnet-5-5" })).toEqual({ status: 202, body: { kind: "set-model" } });
  expect(t.sent).toEqual([{ kind: "setModel", model: "claude-sonnet-5-5" }]);
});

test("model: the current model is a no-op (202 set-model, nothing sent)", async () => {
  const t = setup();
  claudeThread(t);
  expect(await t.post("model", { model: "claude-opus-5-5" })).toEqual({ status: 202, body: { kind: "set-model", unchanged: true } });
  expect(t.sent).toEqual([]);
});

test("model: an unknown or missing model is 400, a model of another harness too", async () => {
  const t = setup();
  claudeThread(t);
  expect((await t.post("model", { model: "claude-imaginary-9" })).status).toBe(400);
  expect((await t.post("model", { model: "gpt-5.6-sol" })).status).toBe(400);
  expect((await t.post("model", {})).status).toBe(400);
  expect(t.sent).toEqual([]);
});

test("model: a proxy profile's model comes from its settings, so it is 400", async () => {
  const t = setup({ agent: "claude-gpt" });
  expect((await t.post("model", { model: "claude-sonnet-5-5" })).status).toBe(400);
  expect(t.sent).toEqual([]);
});

test("model: before the first turn (no native thread) the harness restarts on the model", async () => {
  const t = setup();
  const r = await t.post("model", { model: "claude-sonnet-5-5" });
  expect(r).toEqual({ status: 202, body: { kind: "fresh-with-handoff" } });
  expect(t.sent).toEqual([{
    kind: "switchTarget", target: { harness: "claude", account: "primary", model: "claude-sonnet-5-5", env: { CLAUDE_CONFIG_DIR: "/home/dev/.claude-accounts/primary" } },
    resume: null, handoff: null,
  }]);
});

// --- common refusals ---

test("switch during an active run is 409", async () => {
  const t = setup();
  claudeThread(t);
  t.feed([{ type: "run.queued", runId: "r2", text: "next", attachments: [] }, { type: "run.started", runId: "r2", origin: "user", nativeThreadId: "t-claude", model: null }]);
  for (const [what, body] of [["model", { model: "claude-sonnet-5-5" }], ["account", { accountId: "backup" }], ["harness", { agent: "codex" }]] as const) {
    expect(await t.post(what, body)).toEqual({ status: 409, body: { error: "run-active" } });
  }
  // A queued message counts too: the bridge would apply the switch before it.
  t.feed([{ type: "run.completed", runId: "r2", nativeThreadId: "t-claude", usage: null, costUsd: null }, { type: "run.queued", runId: "r3", text: "later", attachments: [] }]);
  expect((await t.post("account", {})).status).toBe(409);
  expect(t.sent).toEqual([]);
  expect(activeLeases(t)).toEqual(["primary"]);
});

test("a disconnected bridge is 409 agent-disconnected and changes nothing", async () => {
  const t = setup();
  claudeThread(t);
  t.setOnSend(() => { throw new AgentDisconnected("not connected"); });
  expect(await t.post("account", { accountId: "backup" })).toEqual({ status: 409, body: { error: "agent-disconnected" } });
  expect(await t.post("model", { model: "claude-sonnet-5-5" })).toEqual({ status: 409, body: { error: "agent-disconnected" } });
  expect(await t.post("harness", { agent: "codex" })).toEqual({ status: 409, body: { error: "agent-disconnected" } });
  expect(activeLeases(t)).toEqual(["primary"]);
  expect(getSession(t.db, CHAT.id)!.agent).toBe("claude");
});

// --- account ---

test("account: a confirmed switch resumes the thread on the target and moves the lease", async () => {
  const t = setup();
  claudeThread(t);
  expect(await t.post("account", { accountId: "backup" })).toEqual({ status: 202, body: { kind: "restart-resume" } });
  expect(t.sent).toEqual([{
    kind: "switchTarget", target: { harness: "claude", account: "backup", model: "claude-opus-5-5", env: { CLAUDE_CONFIG_DIR: "/home/dev/.claude-accounts/backup" } },
    resume: "t-claude", handoff: null,
  }]);
  const rows = leaseHistory(t.db, "devbox", CHAT.id);
  expect(rows.map((l) => [l.account_id, l.released_at])).toEqual([["backup", null], ["primary", NOW]]);
});

test("account: omitted = the pool's choice (chooseAccount)", async () => {
  const t = setup();
  claudeThread(t);
  expect((await t.post("account", {})).status).toBe(202);
  expect((t.sent[0] as Extract<BridgeCommand, { kind: "switchTarget" }>).target.account).toBe("backup");
  expect(activeLeases(t)).toEqual(["backup"]);
});

test("account: an unusable target (unknown, quarantined, expired) is refused before anything is sent", async () => {
  const t = setup();
  claudeThread(t);
  // Expired = its usage fetch fails permanently (toCandidates leaves it out).
  insertAccount(t.db, { id: "expired", label: "expired", disabled: 0, quarantined_at: null, added_at: 5 });
  upsertAccountUsage(t.db, usage("expired", 0, { five_hour_pct: null, seven_day_pct: null, error: "HTTP 401" }));
  for (const id of ["nope", "jailed", "expired"]) {
    expect(await t.post("account", { accountId: id })).toMatchObject({ status: 400, body: { error: "invalid-account" } });
  }
  expect((await t.post("account", { accountId: 7 })).status).toBe(400);
  expect(t.sent).toEqual([]);
  expect(activeLeases(t)).toEqual(["primary"]);
});

test("account: an account over the threshold is allowed and reported as exhausted (accountSwitch parity)", async () => {
  const t = setup();
  claudeThread(t);
  expect(await t.post("account", { accountId: "full" })).toEqual({ status: 202, body: { kind: "restart-resume", exhausted: true } });
  expect(activeLeases(t)).toEqual(["full"]);
});

test("account: with every account over the threshold the pool still chooses one, reported as exhausted", async () => {
  const t = setup();
  claudeThread(t);
  for (const id of ["primary", "backup", "jailed"]) upsertAccountUsage(t.db, usage(id, 99));
  const r = await t.post("account", {});
  expect(r.status).toBe(202);
  expect(r.body.exhausted).toBe(true);
});

test("account: re-requesting the current account is unchanged, even when it is unusable now", async () => {
  const t = setup();
  claudeThread(t, "jailed");
  expect(await t.post("account", { accountId: "jailed" })).toEqual({ status: 202, body: { kind: "set-model", unchanged: true } });
  expect(t.sent).toEqual([]);
});

test("account: the model id the harness reported (effort variant) keeps its window", async () => {
  const t = setup();
  claudeThread(t, "primary", "claude-opus-5-5-high");
  expect(await t.post("account", { accountId: "backup" })).toEqual({ status: 202, body: { kind: "restart-resume" } });
  expect((t.sent[0] as Extract<BridgeCommand, { kind: "switchTarget" }>).target.model).toBe("claude-opus-5-5-high");
});

test("account: a reported model without a known window is a visible 409 naming it", async () => {
  const t = setup();
  claudeThread(t, "primary", "claude-mystery-1");
  const r = await t.post("account", { accountId: "backup" });
  expect(r).toMatchObject({ status: 409, body: { error: "unknown-model-window" } });
  expect(String(r.body.message)).toContain("claude-mystery-1");
  expect(t.sent).toEqual([]);
});

test("every priced Claude/GPT model id has a window; every offered model too", () => {
  const reported = PRICED_MODELS.filter((m) => /^(claude-|gpt-)/.test(m) && !m.startsWith("gpt-oss"));
  for (const m of reported) expect([m, MODEL_WINDOW_ALIASES[m]]).toEqual([m, expect.any(String)]);
  for (const m of [...CHAT_MODELS.claude, ...CHAT_MODELS.codex]) expect(MODEL_WINDOW_ALIASES[m]).toBe(m);
});

test("account: a profile that cannot be attached is 409 before anything is sent, without the internal cause", async () => {
  const t = setup({ ensureProfile: async () => { throw new Error("docker: volume /srv/secret-path missing"); } });
  claudeThread(t);
  const r = await t.post("account", { accountId: "backup" });
  expect(r).toMatchObject({ status: 409, body: { error: "profile-unavailable" } });
  expect(JSON.stringify(r.body)).not.toContain("secret-path");
  expect(t.sent).toEqual([]);
});

test("account: the bridge refusing the target leaves the lease alone", async () => {
  const t = setup();
  claudeThread(t);
  t.setOnSend(() => { throw new CommandFailed("switch target: Claude account backup has no credentials"); });
  expect(await t.post("account", { accountId: "backup" })).toMatchObject({ status: 409, body: { error: "command-failed" } });
  expect(activeLeases(t)).toEqual(["primary"]);
});

test("account: Codex accounts come from the Codex pool, an unusable one is refused", async () => {
  const t = setup({ agent: "codex", codex: [codexAccount("default"), codexAccount("c-two"), codexAccount("c-out", { usage: { ...codexAccount("x").usage!, state: "signed-out" } })] });
  t.feed([{ type: "thread.native", harness: "codex", nativeThreadId: "t-codex", account: "default", model: "gpt-5.6-sol", caps: CODEX_CAPS }]);
  expect(await t.post("account", { accountId: "c-out" })).toMatchObject({ status: 400, body: { error: "invalid-account" } });
  expect(await t.post("account", { accountId: "c-two" })).toEqual({ status: 202, body: { kind: "restart-resume" } });
  expect(t.sent).toEqual([{ kind: "switchTarget", target: { harness: "codex", account: "c-two", model: "gpt-5.6-sol", env: {} }, resume: "t-codex", handoff: null }]);
});

test("account: a proxy profile has no account pool (400)", async () => {
  const t = setup({ agent: "claude-gpt" });
  expect(await t.post("account", {})).toMatchObject({ status: 400, body: { error: "no-account-pool" } });
});

// --- harness ---

test("harness: an unknown agent or one chat cannot run is 400", async () => {
  const t = setup();
  expect((await t.post("harness", { agent: "nope" })).status).toBe(400);
  expect((await t.post("harness", { agent: "grok" })).status).toBe(400);
  expect((await t.post("harness", {})).status).toBe(400);
  expect(t.sent).toEqual([]);
});

test("harness: Claude → Codex hands the conversation over, updates the agent and releases the Anthropic lease", async () => {
  const t = setup();
  claudeThread(t);
  expect(await t.post("harness", { agent: "codex" })).toEqual({ status: 202, body: { kind: "fresh-with-handoff" } });
  const cmd = t.sent[0] as Extract<BridgeCommand, { kind: "switchTarget" }>;
  expect(cmd.target).toEqual({ harness: "codex", account: "default", model: null, env: {} });
  expect(cmd.resume).toBeNull();
  expect(cmd.handoff!.preamble).toContain("[user] Fix the login bug");
  expect(cmd.handoff!.preamble).toContain("[assistant] Fixed it in auth.ts");
  expect(getSession(t.db, CHAT.id)!.agent).toBe("codex");
  expect(getRepoAgent(t.db, CHAT.folder, CHAT.project, CHAT.repo)).toBe("codex");
  expect(activeLeases(t)).toEqual([]);
});

test("harness: the same agent is a no-op", async () => {
  const t = setup();
  claudeThread(t);
  expect(await t.post("harness", { agent: "claude" })).toEqual({ status: 202, body: { kind: "set-model", unchanged: true } });
  expect(t.sent).toEqual([]);
});

test("harness: a proxy profile resumes the Claude thread with the profile env", async () => {
  const t = setup();
  claudeThread(t);
  expect(await t.post("harness", { agent: "claude-gpt" })).toEqual({ status: 202, body: { kind: "restart-resume" } });
  const cmd = t.sent[0] as Extract<BridgeCommand, { kind: "switchTarget" }>;
  expect(cmd.target).toEqual({
    harness: "claude", account: null, model: "gpt-x",
    env: { ...proxyProfileEnv("claude-gpt", PROXY_INPUTS), CLAUDE_CONFIG_DIR: "/home/dev/.claude" },
  });
  expect(cmd.resume).toBe("t-claude");
  expect(getSession(t.db, CHAT.id)!.agent).toBe("claude-gpt");
  expect(activeLeases(t)).toEqual([]);
});

test("harness: a proxy profile without its key is refused before anything is sent", async () => {
  const t = setup({ proxyInputs: { ...PROXY_INPUTS, DEVD_UPSTREAM_KEY: "", DEVD_CLIPROXY_KEY: "" } });
  claudeThread(t);
  expect(await t.post("harness", { agent: "claude-gpt" })).toMatchObject({ status: 409, body: { error: "profile-unavailable" } });
  expect(t.sent).toEqual([]);
});

test("harness: no room for any history keeps the request path and says so in a notice", async () => {
  // Codex → a proxy profile with a tiny context window: a fresh Claude thread whose budget is 0.
  const t = setup({ agent: "codex", proxyInputs: { ...PROXY_INPUTS, DEVD_AGENT_CTX: "1000" } });
  t.feed([
    { type: "thread.native", harness: "codex", nativeThreadId: "t-codex", account: "default", model: "gpt-5.6-sol", caps: CODEX_CAPS },
    { type: "run.queued", runId: "r1", text: "hello", attachments: [] },
    { type: "run.started", runId: "r1", origin: "user", nativeThreadId: "t-codex", model: "gpt-5.6-sol" },
    { type: "run.completed", runId: "r1", nativeThreadId: "t-codex", usage: null, costUsd: null },
  ]);
  expect(await t.post("harness", { agent: "claude-gpt" })).toEqual({ status: 202, body: { kind: "fresh-with-handoff" } });
  expect((t.sent[0] as Extract<BridgeCommand, { kind: "switchTarget" }>).handoff).toBeNull();
  expect(t.store.snapshot().items.map((i) => i.text)).toContain(historyOmittedNotice(1));
});

// --- bridge events ---

test("a failed resume is re-planned into a fresh thread with the full handoff", async () => {
  const t = setup();
  claudeThread(t);
  t.setOnSend((cmd) => {
    if (cmd.kind === "switchTarget" && cmd.resume !== null) t.feed([{ type: "run.failed", runId: "never-started", error: "resume-failed" }]);
  });
  expect(await t.post("account", { accountId: "backup" })).toEqual({ status: 202, body: { kind: "fresh-with-handoff" } });
  expect(t.sent).toHaveLength(2);
  const retry = t.sent[1] as Extract<BridgeCommand, { kind: "switchTarget" }>;
  expect(retry.target.account).toBe("backup");
  expect(retry.resume).toBeNull();
  expect(retry.handoff!.preamble).toContain("[user] Fix the login bug");
  expect(t.store.providerThread("claude")!.resumeFailed).toBe(true);
  expect(t.store.snapshot().items.some((i) => i.text.startsWith("Could not resume the earlier claude thread"))).toBe(true);
  expect(activeLeases(t)).toEqual(["backup"]);
});

test("a failed re-plan after a failed resume stays visible, but the DB follows the bridge to the target", async () => {
  const t = setup();
  claudeThread(t);
  t.setOnSend((cmd) => {
    if (cmd.kind !== "switchTarget") return;
    if (cmd.resume !== null) t.feed([{ type: "run.failed", runId: "never-started", error: "resume-failed" }]);
    else throw new AgentDisconnected("connection closed");
  });
  expect(await t.post("account", { accountId: "backup" })).toEqual({ status: 409, body: { error: "agent-disconnected" } });
  expect(activeLeases(t)).toEqual(["backup"]);
  expect(t.store.snapshot().items.some((i) => i.text.startsWith("Could not start the fresh claude thread"))).toBe(true);
  // What devd sends next is the target the bridge holds: backup, no thread to resume.
  t.setOnSend(() => {});
  t.feed([{ type: "bridge.started", version: "1", resumed: true, awaitingTarget: true }]);
  await Bun.sleep(0);
  expect((t.sent.at(-1) as Extract<BridgeCommand, { kind: "switchTarget" }>).target.account).toBe("backup");
});

test("a resume failure with no switch in flight is re-planned from the reported (dated) model", async () => {
  const t = setup({ agent: "codex" });
  t.feed([
    { type: "thread.native", harness: "codex", nativeThreadId: "t-codex", account: "default", model: "gpt-5.5-2026-04-23", caps: CODEX_CAPS },
    { type: "run.queued", runId: "r1", text: "hello", attachments: [] },
    { type: "run.started", runId: "r1", origin: "user", nativeThreadId: "t-codex", model: "gpt-5.5-2026-04-23" },
    { type: "run.completed", runId: "r1", nativeThreadId: "t-codex", usage: null, costUsd: null },
    { type: "run.failed", runId: "never-started", error: "resume-failed" },
  ]);
  await Bun.sleep(0);
  expect(t.sent).toHaveLength(1);
  const cmd = t.sent[0] as Extract<BridgeCommand, { kind: "switchTarget" }>;
  expect(cmd.target).toEqual({ harness: "codex", account: "default", model: "gpt-5.5-2026-04-23", env: {} });
  expect(cmd.resume).toBeNull();
  expect(cmd.handoff!.preamble).toContain("[user] hello");
  expect(t.store.providerThread("codex")!.resumeFailed).toBe(true);
});

test("a bridge restart during an in-flight switch gets the switch being sent", async () => {
  const t = setup();
  claudeThread(t);
  let restarted = false;
  t.setOnSend((cmd) => {
    if (cmd.kind === "switchTarget" && !restarted) {
      restarted = true;
      t.feed([{ type: "bridge.started", version: "1", resumed: true, awaitingTarget: true }]);
    }
  });
  expect((await t.post("account", { accountId: "backup" })).status).toBe(202);
  expect(t.sent).toHaveLength(2);
  expect(t.sent[1]).toEqual(t.sent[0]);
});

test("a bridge restarted after a proxy switch gets the target again, with env and the undelivered handoff", async () => {
  const t = setup({ agent: "codex" });
  t.feed([
    { type: "thread.native", harness: "codex", nativeThreadId: "t-codex", account: "default", model: "gpt-5.6-sol", caps: CODEX_CAPS },
    { type: "run.queued", runId: "r1", text: "hello", attachments: [] },
    { type: "run.started", runId: "r1", origin: "user", nativeThreadId: "t-codex", model: "gpt-5.6-sol" },
    { type: "run.completed", runId: "r1", nativeThreadId: "t-codex", usage: null, costUsd: null },
  ]);
  await t.post("harness", { agent: "claude-gpt" });
  const first = t.sent[0] as Extract<BridgeCommand, { kind: "switchTarget" }>;
  expect(first.handoff!.preamble).toContain("[user] hello");
  t.feed([{ type: "bridge.started", version: "1", resumed: true, awaitingTarget: true }]);
  await Bun.sleep(0);
  expect(t.sent[1]).toEqual(first);
  // Once the next message took the handoff, a later re-send carries none, and resumes the announced thread.
  t.feed([
    { type: "run.queued", runId: "r2", text: "go on", attachments: [] },
    { type: "thread.native", harness: "claude", nativeThreadId: "t-new", account: null, model: "gpt-x", caps: CLAUDE_CAPS },
    { type: "bridge.started", version: "1", resumed: true, awaitingTarget: true },
  ]);
  await Bun.sleep(0);
  expect(t.sent[2]).toEqual({ ...first, resume: "t-new", handoff: null });
});

test("after a devd restart the awaited target is rebuilt from the session's profile", async () => {
  const t = setup({ agent: "claude-gpt" });
  t.feed([
    { type: "thread.native", harness: "claude", nativeThreadId: "t-claude", account: null, model: "gpt-x", caps: CLAUDE_CAPS },
    { type: "bridge.started", version: "1", resumed: true, awaitingTarget: true },
  ]);
  await Bun.sleep(0);
  expect(t.sent).toEqual([{
    kind: "switchTarget", target: { harness: "claude", account: null, model: "gpt-x", env: { ...proxyProfileEnv("claude-gpt", PROXY_INPUTS), CLAUDE_CONFIG_DIR: "/home/dev/.claude" } },
    resume: "t-claude", handoff: null,
  }]);
});

// --- proxy profile env ---

async function printEnv(profile: string, inputs: Record<string, string>): Promise<Record<string, string>> {
  const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: tmpdir(), ...inputs };
  const p = Bun.spawn(["bash", join(import.meta.dir, "..", "..", "image", "agent-launch.sh"), profile, "--print-env"], { env, stdout: "pipe", stderr: "ignore" });
  const out = await new Response(p.stdout).text();
  await p.exited;
  return Object.fromEntries(out.trim().split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
}

test("proxyProfileEnv matches agent-launch.sh --print-env for each proxy profile", async () => {
  for (const profile of PROXY_PROFILES) {
    for (const inputs of [PROXY_INPUTS, { DEVD_CLIPROXY_URL: "http://old:8317", DEVD_CLIPROXY_KEY: "k-old", DEVD_AGENT_MODEL: "m-1" }] as Record<string, string>[]) {
      const ours = proxyProfileEnv(profile, inputs);
      // --print-env masks the token; the value itself is checked against the input.
      expect(ours.ANTHROPIC_AUTH_TOKEN).toBe(inputs.DEVD_UPSTREAM_KEY ?? inputs.DEVD_CLIPROXY_KEY);
      expect<Record<string, string>>({ ...ours, ANTHROPIC_AUTH_TOKEN: "<set>" }).toEqual(await printEnv(profile, inputs));
    }
  }
});

test("proxy profile env keys are the ones an agent switch clears (PROFILE_ENV)", () => {
  expect([...PROXY_PROFILE_ENV_KEYS].sort()).toEqual([...PROFILE_ENV].sort());
});
