import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { BridgeCommand } from "../../image/agent-bridge/src/protocol";
import { PROXY_PROFILE_ENV_KEYS, PROXY_PROFILES, proxyProfileEnv } from "../../image/agent-bridge/src/proxyProfile";
import type { BridgeEvent, Capabilities } from "../../shared/thread";
import { PROFILE_ENV } from "../src/agentSwitch";
import { BRIDGE_VERSION } from "../../image/agent-bridge/src/version";
import { AgentDisconnected, CommandFailed } from "../src/bridgeLink";
import { CHAT_MODELS, ChatSwitch, MODEL_WINDOW_ALIASES, type ChatSwitchDeps } from "../src/chatSwitch";
import { PRICED_MODELS } from "../src/pricing";
import type { CodexAccountView } from "../src/codexAccounts";
import { ACCOUNT_POOL_DEFAULTS } from "../src/config";
import {
  getRepoAgent, getSession, insertAccount, insertLease, insertSession, leaseHistory, openDb, setRepoAgent, upsertAccountUsage,
  type AccountUsageRow, type SessionRow,
} from "../src/db";
import { EventBus } from "../src/eventBus";
import { resolveAgent } from "../src/sessions";
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

function setup(o: { agent?: SessionRow["agent"]; codex?: CodexAccountView[]; proxyInputs?: Record<string, string>; ensureProfile?: ChatSwitchDeps["ensureClaudeProfile"]; codexMounted?: ChatSwitchDeps["codexAccountMounted"] } = {}) {
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
  const published: unknown[] = [];
  const store = ThreadStore.open(dir, CHAT.id, { onNotice: (item) => published.push(item.text) });
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
    codexAccountMounted: o.codexMounted,
    resendDelaysMs: [10, 20, 40],
    proxyInputs: async () => o.proxyInputs ?? PROXY_INPUTS,
    now: () => NOW,
    log: () => {},
  };
  const sw = new ChatSwitch(deps);
  cleanups.push(() => sw.drop(CHAT.id));
  const app = new Hono();
  registerThreadRoutes(app, {
    db, root: dir, mgr: { isEnding: () => false }, threads: () => store, bus: new EventBus(), inbox: { changedSafe: () => {} } as never, bridgeVersion: (id) => sw.bridgeVersion(id),
    links: { send: deps.links.send, ensure: () => {}, startTurnWhenConnected: () => {} }, switcher: sw, untilReset: () => { throw new Error("not used"); },
  });
  const post = async (what: string, body: unknown) => {
    const r = await app.fetch(new Request(`http://x/api/sessions/${CHAT.id}/thread/${what}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }));
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  /** A handshake of the session's bridge (BridgeLinks.onHandshake). */
  const handshake = (awaitingTarget: boolean, version: string | null = "1.1.0") => sw.onHandshake(CHAT.id, { version, awaitingTarget });
  return { db, store, sent, feed, post, sw, app, published, handshake, setOnSend: (f: (cmd: BridgeCommand) => void) => { onSend = f; } };
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
  const t = setup({ agent: "claude-gemini" });
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
  for (const m of Object.values(CHAT_MODELS).flat()) expect(MODEL_WINDOW_ALIASES[m]).toBe(m);
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
  const t = setup({ agent: "claude-gemini" });
  expect(await t.post("account", {})).toMatchObject({ status: 400, body: { error: "no-account-pool" } });
});

// --- harness ---

test("harness: an unknown agent or one chat cannot run is 400", async () => {
  const t = setup();
  expect((await t.post("harness", { agent: "nope" })).status).toBe(400);
  const r = await t.post("harness", { agent: "antigravity" });
  expect(r).toMatchObject({ status: 400, body: { error: "unknown-agent" } });
  expect(String(r.body.message)).toContain("is not available in chat sessions yet");
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
  expect(await t.post("harness", { agent: "claude-gemini" })).toEqual({ status: 202, body: { kind: "restart-resume" } });
  const cmd = t.sent[0] as Extract<BridgeCommand, { kind: "switchTarget" }>;
  expect(cmd.target).toEqual({
    harness: "claude", account: null, model: "gpt-x",
    env: { ...proxyProfileEnv("claude-gemini", PROXY_INPUTS), CLAUDE_CONFIG_DIR: "/home/dev/.claude" },
  });
  expect(cmd.resume).toBe("t-claude");
  expect(getSession(t.db, CHAT.id)!.agent).toBe("claude-gemini");
  expect(activeLeases(t)).toEqual([]);
});

test("harness: a proxy profile without its key is refused before anything is sent", async () => {
  const t = setup({ proxyInputs: { ...PROXY_INPUTS, DEVD_UPSTREAM_KEY: "", DEVD_CLIPROXY_KEY: "" } });
  claudeThread(t);
  expect(await t.post("harness", { agent: "claude-gemini" })).toMatchObject({ status: 409, body: { error: "profile-unavailable" } });
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
  expect(await t.post("harness", { agent: "claude-gemini" })).toEqual({ status: 202, body: { kind: "fresh-with-handoff" } });
  expect((t.sent[0] as Extract<BridgeCommand, { kind: "switchTarget" }>).handoff).toBeNull();
  expect(t.store.snapshot().items.map((i) => i.text)).toContain(historyOmittedNotice(1));
});

const VIBE_CAPS: Capabilities = { resume: true, injectItems: false, liveModelSwitch: true, questions: false, images: true, backgroundVisibility: false };
/** A Vibe turn on its own thread, as the bridge announces it. */
function vibeTurn(t: ReturnType<typeof setup>, runId: string, caps = VIBE_CAPS, model = "mistral-large-4-0") {
  t.feed([
    { type: "thread.native", harness: "vibe", nativeThreadId: "t-vibe", account: null, model, caps },
    { type: "run.queued", runId, text: `ask ${runId}`, attachments: [] },
    { type: "run.started", runId, origin: "user", nativeThreadId: "t-vibe", model },
    { type: "message.final", runId, itemId: `m-${runId}`, role: "assistant", text: `answer ${runId}` },
    { type: "run.completed", runId, nativeThreadId: "t-vibe", usage: null, costUsd: null },
  ]);
}

test("harness: Claude → Vibe is a fresh thread with the handoff, on no account, and releases the Anthropic lease", async () => {
  const t = setup();
  claudeThread(t);
  expect(await t.post("harness", { agent: "vibe" })).toEqual({ status: 202, body: { kind: "fresh-with-handoff" } });
  const cmd = t.sent[0] as Extract<BridgeCommand, { kind: "switchTarget" }>;
  expect(cmd.target).toEqual({ harness: "vibe", account: null, model: null, env: {} });
  expect(cmd.resume).toBeNull();
  expect(cmd.handoff!.preamble).toContain("[user] Fix the login bug");
  expect(getSession(t.db, CHAT.id)!.agent).toBe("vibe");
  expect(activeLeases(t)).toEqual([]);
});

test("harness: a switch to Vibe leaves the repo's remembered agent alone (S4-P6); a scheduled open still gets it", async () => {
  const t = setup();
  claudeThread(t);
  setRepoAgent(t.db, CHAT.folder, CHAT.project, CHAT.repo, "codex", NOW - HOUR);
  expect((await t.post("harness", { agent: "vibe" })).status).toBe(202);
  expect(getSession(t.db, CHAT.id)!.agent).toBe("vibe");
  expect(getRepoAgent(t.db, CHAT.folder, CHAT.project, CHAT.repo)).toBe("codex");
  // The scheduler opens without an agent: SessionManager.open resolves it from memory.
  expect(resolveAgent(undefined, getRepoAgent(t.db, CHAT.folder, CHAT.project, CHAT.repo))).toBe("codex");
});

test("harness: back to Vibe resumes its thread with a delta; an ACP agent that cannot resume gets a fresh thread", async () => {
  for (const [caps, kind, resume] of [[VIBE_CAPS, "resume-with-delta", "t-vibe"], [{ ...VIBE_CAPS, resume: false }, "fresh-with-handoff", null]] as const) {
    const t = setup({ agent: "vibe" });
    vibeTurn(t, "r1", caps);
    expect(await t.post("harness", { agent: "claude" })).toMatchObject({ status: 202 });
    t.feed([
      { type: "thread.native", harness: "claude", nativeThreadId: "t-claude", account: "primary", model: "claude-opus-5-5", caps: CLAUDE_CAPS },
      { type: "run.queued", runId: "r2", text: "now on claude", attachments: [] },
      { type: "run.started", runId: "r2", origin: "user", nativeThreadId: "t-claude", model: "claude-opus-5-5" },
      { type: "run.completed", runId: "r2", nativeThreadId: "t-claude", usage: null, costUsd: null },
    ]);
    expect(await t.post("harness", { agent: "vibe" })).toEqual({ status: 202, body: { kind } });
    const cmd = t.sent.at(-1) as Extract<BridgeCommand, { kind: "switchTarget" }>;
    // Another harness's model does not carry over: Vibe runs its own default (as Codex after Claude).
    expect(cmd.target).toEqual({ harness: "vibe", account: null, model: null, env: {} });
    expect(cmd.resume).toBe(resume);
    expect(cmd.handoff!.preamble).toContain("now on claude");
  }
});

test("model: Vibe switches among its models live; another harness's model is 400", async () => {
  const t = setup({ agent: "vibe" });
  vibeTurn(t, "r1");
  expect(await t.post("model", { model: "mistral-medium-3.5" })).toEqual({ status: 202, body: { kind: "set-model" } });
  expect(t.sent).toEqual([{ kind: "setModel", model: "mistral-medium-3.5" }]);
  expect(await t.post("model", { model: "claude-opus-5-5" })).toMatchObject({ status: 400, body: { error: "unknown-model" } });
  // A reloaded Vibe session names Medium 3.5 "mistral-medium-latest": an alias with a window, not a default.
  expect(MODEL_WINDOW_ALIASES["mistral-medium-latest"]).toBe("mistral-medium-3.5");
});

test("Grok: its default grok-4.7 switches to another Grok model live and hands over to Claude", async () => {
  const t = setup({ agent: "grok" });
  t.feed([
    { type: "thread.native", harness: "grok", nativeThreadId: "t-grok", account: null, model: "grok-4.7", caps: { ...VIBE_CAPS, images: false } },
    { type: "run.queued", runId: "r1", text: "ask r1", attachments: [] },
    { type: "run.started", runId: "r1", origin: "user", nativeThreadId: "t-grok", model: "grok-4.7" },
    { type: "message.final", runId: "r1", itemId: "m-r1", role: "assistant", text: "answer r1" },
    { type: "run.completed", runId: "r1", nativeThreadId: "t-grok", usage: null, costUsd: null },
  ]);
  expect(await t.post("model", { model: "grok-4.6" })).toEqual({ status: 202, body: { kind: "set-model" } });
  expect(t.sent).toEqual([{ kind: "setModel", model: "grok-4.6" }]);
  expect(await t.post("harness", { agent: "claude" })).toMatchObject({ status: 202, body: { kind: "fresh-with-handoff" } });
});

test("account: an ACP agent runs on its own CLI login, not on an account pool (400)", async () => {
  const t = setup({ agent: "vibe" });
  expect(await t.post("account", {})).toMatchObject({ status: 400, body: { error: "no-account-pool" } });
});

// --- the switch notice and the current target ---

const notices = (t: ReturnType<typeof setup>) => t.store.snapshot().items.filter((i) => i.kind === "notice").map((i) => i.text);

test("a confirmed switch says in the thread what it switched to and what was handed over", async () => {
  const t = setup();
  claudeThread(t);
  await t.post("model", { model: "claude-sonnet-5-5" });
  await t.post("account", { accountId: "backup" });
  await t.post("harness", { agent: "codex" });
  expect(notices(t)).toEqual([
    "Switched model to claude-sonnet-5-5",
    "Switched account to backup · resumed",
    "Switched to Codex · context handed over (2 items)",
  ]);
});

test("the switch notice counts omitted items; a refused or unchanged switch adds none", async () => {
  const t = setup({ agent: "codex", proxyInputs: { ...PROXY_INPUTS, DEVD_AGENT_CTX: "1000" } });
  t.feed([
    { type: "thread.native", harness: "codex", nativeThreadId: "t-codex", account: "default", model: "gpt-5.6-sol", caps: CODEX_CAPS },
    { type: "run.queued", runId: "r1", text: "hello", attachments: [] },
    { type: "run.completed", runId: "r1", nativeThreadId: "t-codex", usage: null, costUsd: null },
  ]);
  expect((await t.post("harness", { agent: "codex" })).status).toBe(202);
  expect((await t.post("account", { accountId: "nope" })).status).toBe(400);
  expect(notices(t)).toEqual([]);
  await t.post("harness", { agent: "claude-gemini" });
  expect(notices(t)).toEqual(["Switched to Claude Code + Gemini · no history handed over", historyOmittedNotice(1)]);
});

test("a resumed thread with a delta says how much of it was handed over", async () => {
  const t = setup({ agent: "codex" });
  t.feed([
    { type: "thread.native", harness: "codex", nativeThreadId: "t-codex", account: "default", model: "gpt-5.6-sol", caps: CODEX_CAPS },
    { type: "run.queued", runId: "r1", text: "hello", attachments: [] },
    { type: "run.completed", runId: "r1", nativeThreadId: "t-codex", usage: null, costUsd: null },
  ]);
  await t.post("harness", { agent: "claude" });
  t.feed([
    { type: "thread.native", harness: "claude", nativeThreadId: "t-claude", account: "backup", model: "claude-opus-5-5", caps: CLAUDE_CAPS },
    { type: "run.queued", runId: "r2", text: "on claude", attachments: [] },
    { type: "run.completed", runId: "r2", nativeThreadId: "t-claude", usage: null, costUsd: null },
  ]);
  expect(await t.post("harness", { agent: "codex" })).toEqual({ status: 202, body: { kind: "resume-with-delta" } });
  expect(notices(t).at(-1)).toBe("Switched to Codex · resumed · context handed over (1 items)");
  // A record of the user's own action: a plain notice.
  expect(t.store.snapshot().items.at(-1)?.tone).toBeUndefined();
});

test("GET thread/target is the target devd plans the next switch from", async () => {
  const t = setup();
  const get = async () => {
    const r = await t.app.fetch(new Request(`http://x/api/sessions/${CHAT.id}/thread/target`));
    return { status: r.status, body: await r.json() };
  };
  expect(await get()).toEqual({ status: 200, body: { agent: "claude", harness: "claude", account: "primary", model: null, awaitingTarget: false, bridgeVersion: null, bridgeOutdated: false } });
  claudeThread(t);
  await t.post("account", { accountId: "backup" });
  expect(await get()).toEqual({ status: 200, body: { agent: "claude", harness: "claude", account: "backup", model: "claude-opus-5-5", awaitingTarget: false, bridgeVersion: null, bridgeOutdated: false } });
  await t.post("harness", { agent: "codex" });
  expect(await get()).toEqual({ status: 200, body: { agent: "codex", harness: "codex", account: "default", model: null, awaitingTarget: false, bridgeVersion: null, bridgeOutdated: false } });
});

test("GET thread/target says whether the session's bridge is older than this devd's, while it is", async () => {
  const t = setup();
  const outdated = async () => ((await (await t.app.fetch(new Request(`http://x/api/sessions/${CHAT.id}/thread/target`))).json()) as { bridgeOutdated: boolean }).bridgeOutdated;
  t.handshake(false, "1.4.0");
  expect(await outdated()).toBe(true);
  t.handshake(false, BRIDGE_VERSION);
  expect(await outdated()).toBe(false);
  // No version known (before a handshake, or a bridge too old to name one): not claimed either way.
  t.handshake(false, null);
  expect(await outdated()).toBe(false);
});

test("after a failed resume the switch notice says so", async () => {
  const t = setup();
  claudeThread(t);
  t.setOnSend((cmd) => {
    if (cmd.kind === "switchTarget" && cmd.resume !== null) t.feed([{ type: "run.failed", runId: "never-started", error: "resume-failed" }]);
  });
  await t.post("account", { accountId: "backup" });
  // M4: one notice for the switch and its failed resume.
  expect(notices(t)).toEqual(["Switched account to backup · resume failed, started a fresh thread · context handed over (2 items)"]);
});

test("a resume failure re-planned out of band is published like every notice", async () => {
  const t = setup({ agent: "codex" });
  t.feed([
    { type: "thread.native", harness: "codex", nativeThreadId: "t-codex", account: "default", model: "gpt-5.5", caps: CODEX_CAPS },
    { type: "run.queued", runId: "r1", text: "hello", attachments: [] },
    { type: "run.completed", runId: "r1", nativeThreadId: "t-codex", usage: null, costUsd: null },
    { type: "run.failed", runId: "never-started", error: "resume-failed" },
  ]);
  await Bun.sleep(0);
  // M4: one notice.
  expect(t.published).toEqual(["Could not resume the earlier codex thread; started a fresh one · context handed over (1 items)"]);
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
  expect(notices(t)).toEqual(["Switched account to backup · resume failed, started a fresh thread · context handed over (2 items)"]);
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
  expect(notices(t).at(-1)).toStartWith("The agent waits for its target");
  expect(t.store.snapshot().items.at(-1)?.tone).toBe("warn");
  // What devd sends on the next handshake is the target the bridge holds: backup, a fresh thread, the full handoff.
  t.setOnSend(() => {});
  t.handshake(true);
  await Bun.sleep(0);
  const resent = t.sent.at(-1) as Extract<BridgeCommand, { kind: "switchTarget" }>;
  expect(resent).toMatchObject({ target: { account: "backup" }, resume: null });
  expect(resent.handoff!.preamble).toContain("[user] Fix the login bug");
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

test("a handshake awaiting the target during an in-flight switch leaves it to that switch, which settles it", async () => {
  const t = setup();
  claudeThread(t);
  let restarted = false;
  t.setOnSend((cmd) => {
    if (cmd.kind === "switchTarget" && !restarted) {
      restarted = true;
      t.handshake(true);
    }
  });
  expect((await t.post("account", { accountId: "backup" })).status).toBe(202);
  await Bun.sleep(60);
  expect(t.sent).toHaveLength(1);
});

test("a bridge restarted after a proxy switch gets the target again, with env and the undelivered handoff", async () => {
  const t = setup({ agent: "codex" });
  t.feed([
    { type: "thread.native", harness: "codex", nativeThreadId: "t-codex", account: "default", model: "gpt-5.6-sol", caps: CODEX_CAPS },
    { type: "run.queued", runId: "r1", text: "hello", attachments: [] },
    { type: "run.started", runId: "r1", origin: "user", nativeThreadId: "t-codex", model: "gpt-5.6-sol" },
    { type: "run.completed", runId: "r1", nativeThreadId: "t-codex", usage: null, costUsd: null },
  ]);
  await t.post("harness", { agent: "claude-gemini" });
  const first = t.sent[0] as Extract<BridgeCommand, { kind: "switchTarget" }>;
  expect(first.handoff!.preamble).toContain("[user] hello");
  t.feed([{ type: "bridge.started", version: "1.1.0", resumed: true, awaitingTarget: true }]);
  t.handshake(true);
  await Bun.sleep(0);
  expect(t.sent[1]).toEqual(first);
  // Once the next message took the handoff, a later re-send carries none, and resumes the announced thread.
  t.feed([
    { type: "run.queued", runId: "r2", text: "go on", attachments: [] },
    { type: "thread.native", harness: "claude", nativeThreadId: "t-new", account: null, model: "gpt-x", caps: CLAUDE_CAPS },
    { type: "bridge.started", version: "1.1.0", resumed: true, awaitingTarget: true },
  ]);
  t.handshake(true);
  await Bun.sleep(0);
  expect(t.sent[2]).toEqual({ ...first, resume: "t-new", handoff: null });
});

test("after a devd restart the awaited target is rebuilt from the session's profile", async () => {
  const t = setup({ agent: "claude-gemini" });
  t.feed([
    { type: "thread.native", harness: "claude", nativeThreadId: "t-claude", account: null, model: "gpt-x", caps: CLAUDE_CAPS },
    { type: "bridge.started", version: "1.1.0", resumed: true, awaitingTarget: true },
  ]);
  t.handshake(true);
  await Bun.sleep(0);
  expect(t.sent).toEqual([{
    kind: "switchTarget", target: { harness: "claude", account: null, model: "gpt-x", env: { ...proxyProfileEnv("claude-gemini", PROXY_INPUTS), CLAUDE_CONFIG_DIR: "/home/dev/.claude" } },
    resume: "t-claude", handoff: null,
  }]);
});

// --- final review fixes ---

const waitUntil = async (cond: () => boolean, what: string, ms = 1000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
};
const targets = (t: ReturnType<typeof setup>) => t.sent.filter((c): c is Extract<BridgeCommand, { kind: "switchTarget" }> => c.kind === "switchTarget");

test("C1: a resume failure reported at the bridge's start (no switch in flight, devd memory gone) is re-planned into the same target, fresh, with the handoff", async () => {
  const t = setup({ agent: "codex" });
  t.feed([
    { type: "thread.native", harness: "codex", nativeThreadId: "t-step2", account: "c-two", model: "gpt-5.5", caps: CODEX_CAPS },
    { type: "run.queued", runId: "r1", text: "hello", attachments: [] },
    { type: "run.completed", runId: "r1", nativeThreadId: "t-step2", usage: null, costUsd: null },
    { type: "bridge.started", version: "1.1.0", resumed: true },
    { type: "run.failed", runId: "never-started", error: "resume-failed" },
  ]);
  // The bridge's handshake after the failure says it awaits the target: still one re-plan, one send.
  t.handshake(true);
  await waitUntil(() => t.sent.length > 0, "re-plan");
  await Bun.sleep(30);
  expect(targets(t)).toHaveLength(1);
  expect(targets(t)[0]).toMatchObject({ target: { harness: "codex", account: "c-two", model: "gpt-5.5" }, resume: null });
  expect(targets(t)[0].handoff!.preamble).toContain("[user] hello");
  expect(t.store.providerThread("codex")).toMatchObject({ nativeThreadId: "t-step2", resumeFailed: true });
  expect(notices(t)).toEqual(["Agent bridge restarted (v1.1.0)", "Could not resume the earlier codex thread; started a fresh one · context handed over (1 items)"]);
});

test("I1: a re-send after a devd restart carries no handoff, so the bridge keeps its own; a message that started at once clears devd's copy", async () => {
  const t = setup({ agent: "codex" });
  t.feed([
    { type: "thread.native", harness: "codex", nativeThreadId: "t-codex", account: "default", model: "gpt-5.6-sol", caps: CODEX_CAPS },
    { type: "run.queued", runId: "r1", text: "hello", attachments: [] },
    { type: "run.completed", runId: "r1", nativeThreadId: "t-codex", usage: null, costUsd: null },
  ]);
  await t.post("harness", { agent: "claude-gemini" });
  expect(targets(t)[0].handoff).not.toBeNull();
  // The next user message starts at once (no run.queued): the bridge delivered the handoff with it.
  t.feed([
    { type: "run.started", runId: "r2", origin: "user", nativeThreadId: null, model: null },
    { type: "thread.native", harness: "claude", nativeThreadId: "t-gpt", account: null, model: "gpt-x", caps: CLAUDE_CAPS },
    { type: "run.completed", runId: "r2", nativeThreadId: "t-gpt", usage: null, costUsd: null },
  ]);
  t.handshake(true);
  await waitUntil(() => targets(t).length === 2, "re-send");
  expect(targets(t)[1]).toMatchObject({ resume: "t-gpt", handoff: null });
});

test("I2: a bridge awaiting its target gets it again with backoff while sends fail, with one notice, and on every handshake", async () => {
  const t = setup({ agent: "claude-gemini" });
  t.feed([{ type: "thread.native", harness: "claude", nativeThreadId: "t-claude", account: null, model: "gpt-x", caps: CLAUDE_CAPS }]);
  let fail = true;
  t.setOnSend((cmd) => { if (cmd.kind === "switchTarget" && fail) throw new CommandFailed("unknown-model-window"); });
  t.handshake(true);
  await waitUntil(() => t.sent.length >= 4, "retries");
  expect(notices(t)).toHaveLength(1);
  expect(notices(t)[0]).toStartWith("The agent waits for its target");
  expect(notices(t)[0]).toContain("unknown-model-window");
  fail = false;
  await waitUntil(() => t.sent.length >= 5, "the successful retry");
  const settled = t.sent.length;
  await Bun.sleep(100);
  expect(t.sent.length).toBe(settled);
  expect(notices(t)).toHaveLength(1);

  // A link that drops waits for its next handshake instead of a timer; that handshake sends at once.
  t.setOnSend((cmd) => { if (cmd.kind === "switchTarget") throw new AgentDisconnected("connection closed"); });
  t.handshake(true);
  await Bun.sleep(100);
  const afterDrop = t.sent.length;
  expect(afterDrop).toBe(settled + 1);
  t.setOnSend(() => {});
  t.handshake(true);
  await waitUntil(() => t.sent.length === afterDrop + 1, "the send on reconnect");
  // A new failure episode got its own notice; a handshake that does not await stops everything.
  expect(notices(t)).toHaveLength(2);
});

test("I2: a handshake that no longer awaits stops the retries", async () => {
  const t = setup({ agent: "claude-gemini" });
  t.feed([{ type: "thread.native", harness: "claude", nativeThreadId: "t-claude", account: null, model: "gpt-x", caps: CLAUDE_CAPS }]);
  t.setOnSend((cmd) => { if (cmd.kind === "switchTarget") throw new CommandFailed("nope"); });
  t.handshake(true);
  await waitUntil(() => t.sent.length >= 2, "a retry");
  t.handshake(false);
  const stopped = t.sent.length;
  await Bun.sleep(100);
  expect(t.sent.length).toBe(stopped);
});

test("I2: while the bridge awaits its target the user can switch despite queued messages, and a model pick is sent as the target", async () => {
  const t = setup();
  claudeThread(t);
  t.feed([{ type: "run.queued", runId: "r2", text: "waiting for a target", attachments: [] }]);
  expect(await t.post("model", { model: "claude-sonnet-5-5" })).toEqual({ status: 409, body: { error: "run-active" } });
  let refuse = true;
  t.setOnSend((cmd) => { if (cmd.kind === "switchTarget" && refuse) throw new CommandFailed("not yet"); });
  t.handshake(true);
  await waitUntil(() => t.sent.length >= 1, "first re-send");
  refuse = false;
  expect(await t.post("model", { model: "claude-sonnet-5-5" })).toEqual({ status: 202, body: { kind: "set-model" } });
  const last = t.sent.at(-1)!;
  expect(last).toMatchObject({ kind: "switchTarget", target: { harness: "claude", account: "primary", model: "claude-sonnet-5-5" }, resume: "t-claude" });
  // Settled: no more re-sends, and the next switch is refused while the message is queued again.
  const n = t.sent.length;
  await Bun.sleep(80);
  expect(t.sent.length).toBe(n);
  expect((await t.post("model", { model: "claude-opus-5-5" })).status).toBe(409);
});

test("P24a: GET thread/target says whether the bridge awaits its target", async () => {
  const t = setup();
  claudeThread(t);
  t.setOnSend((cmd) => { if (cmd.kind === "switchTarget") throw new CommandFailed("not yet"); });
  t.handshake(true);
  await waitUntil(() => t.sent.length >= 1, "first re-send");
  expect(t.sw.target(CHAT.id).awaitingTarget).toBe(true);
  const r = await t.app.fetch(new Request(`http://x/api/sessions/${CHAT.id}/thread/target`));
  expect(((await r.json()) as Record<string, unknown>).awaitingTarget).toBe(true);
  t.handshake(false);
  expect(t.sw.target(CHAT.id).awaitingTarget).toBe(false);
});

test("I2: picking the current target while the bridge awaits it sends it instead of answering unchanged", async () => {
  const t = setup();
  claudeThread(t);
  t.setOnSend((cmd) => { if (cmd.kind === "switchTarget") throw new CommandFailed("not yet"); });
  t.handshake(true);
  await waitUntil(() => t.sent.length >= 1, "first re-send");
  t.setOnSend(() => {});
  const r = await t.post("model", { model: "claude-opus-5-5" });
  expect(r.status).toBe(202);
  expect(r.body.unchanged).toBeUndefined();
  expect(t.sent.at(-1)).toMatchObject({ kind: "switchTarget", target: { model: "claude-opus-5-5" } });
});

test("I3: a bridge that restarted on its own target is what devd plans from (another account leased after a recreate)", async () => {
  const t = setup();
  claudeThread(t);
  await t.post("model", { model: "claude-sonnet-5-5" });
  t.feed([
    { type: "bridge.started", version: "1.1.0", resumed: true },
    { type: "thread.native", harness: "claude", nativeThreadId: "t-claude", account: "backup", model: null, caps: CLAUDE_CAPS },
  ]);
  expect(t.sw.target(CHAT.id)).toMatchObject({ harness: "claude", account: "backup" });
});

test("M1: a bridge older than switching is refused with 409 bridge-too-old before anything is sent", async () => {
  const t = setup();
  claudeThread(t);
  t.handshake(false, null);
  expect(await t.post("model", { model: "claude-sonnet-5-5" })).toEqual({ status: 409, body: { error: "bridge-too-old", message: expect.stringContaining("recreate") } });
  expect(t.sent).toEqual([]);
  t.handshake(false, "1.1.0");
  expect((await t.post("model", { model: "claude-sonnet-5-5" })).status).toBe(202);
});

test("a bridge older than 1.2.0 cannot take an ACP harness: 409 bridge-too-old before anything is sent", async () => {
  const t = setup();
  claudeThread(t);
  t.handshake(false, "1.1.0");
  expect(await t.post("harness", { agent: "vibe" })).toEqual({
    status: 409, body: { error: "bridge-too-old", message: "recreate the container to use Mistral Vibe" },
  });
  expect(t.sent).toEqual([]);
  expect(getSession(t.db, CHAT.id)!.agent).toBe("claude");
  // Claude/Codex switches still work on it.
  expect((await t.post("harness", { agent: "codex" })).status).toBe(202);
  expect(t.sw.target(CHAT.id).bridgeVersion).toBe("1.1.0");
});

test("a 1.2.0 bridge takes an ACP harness", async () => {
  const t = setup();
  claudeThread(t);
  t.handshake(false, "1.2.0");
  expect(await t.post("harness", { agent: "vibe" })).toMatchObject({ status: 202 });
  expect(t.sw.target(CHAT.id).bridgeVersion).toBe("1.2.0");
  expect(t.sw.bridgeVersion(CHAT.id)).toBe("1.2.0");
});

test("M5: a Codex account not mounted in the container is refused with 409 account-not-mounted before anything is sent", async () => {
  const checked: string[] = [];
  const t = setup({ agent: "codex", codexMounted: async (_c, id) => { checked.push(id); return id === "default"; } });
  t.feed([{ type: "thread.native", harness: "codex", nativeThreadId: "t-codex", account: "default", model: "gpt-5.5", caps: CODEX_CAPS }]);
  expect(await t.post("account", { accountId: "c-two" })).toEqual({ status: 409, body: { error: "account-not-mounted", message: expect.stringContaining("recreate") } });
  expect(checked).toEqual(["c-two"]);
  expect(t.sent).toEqual([]);
  const broken = setup({ agent: "codex", codexMounted: async () => { throw new Error("docker inspect failed"); } });
  broken.feed([{ type: "thread.native", harness: "codex", nativeThreadId: "t-codex", account: "default", model: "gpt-5.5", caps: CODEX_CAPS }]);
  expect((await broken.post("account", { accountId: "c-two" })).body.error).toBe("profile-unavailable");
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

test("a harness switch the bridge could not open says so in the thread; the session stays where it was", async () => {
  const t = setup();
  claudeThread(t);
  t.setOnSend((cmd) => { if (cmd.kind === "switchTarget") throw new CommandFailed("Authentication required"); });
  expect(await t.post("harness", { agent: "vibe" })).toEqual({ status: 409, body: { error: "command-failed", message: "Authentication required" } });
  expect(notices(t).at(-1)).toBe("Switching to Mistral Vibe failed: Authentication required. The session stays on Claude Code.");
  expect(t.store.snapshot().items.at(-1)?.tone).toBe("warn");
  expect(getSession(t.db, CHAT.id)!.agent).toBe("claude");
  expect(activeLeases(t)).toEqual(["primary"]);
});

test("open-failed: the bridge could not open its persisted target and awaits one; devd re-sends it and the user can switch away", async () => {
  const t = setup({ agent: "vibe" });
  vibeTurn(t, "r1");
  t.setOnSend((cmd) => { if (cmd.kind === "switchTarget" && cmd.target.harness === "vibe") throw new CommandFailed("Authentication required"); });
  t.feed([{ type: "run.failed", runId: "never-started", error: "open-failed" }]);
  await waitUntil(() => t.sent.length >= 1, "the re-send");
  // Same thread, no re-plan: the thread was fine, the agent could not start.
  expect(t.sent[0]).toMatchObject({ kind: "switchTarget", target: { harness: "vibe" }, resume: "t-vibe" });
  expect(t.sw.target(CHAT.id).awaitingTarget).toBe(true);
  expect(notices(t).at(-1)).toContain("Authentication required");
  expect(t.store.snapshot().items.some((i) => i.text.includes("never-started"))).toBe(false);
  expect(await t.post("harness", { agent: "claude" })).toMatchObject({ status: 202 });
  expect(t.sent.at(-1)).toMatchObject({ kind: "switchTarget", target: { harness: "claude" } });
  expect(t.sw.target(CHAT.id).awaitingTarget).toBe(false);
});
