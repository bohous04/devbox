import { describe, expect, test } from "bun:test";
import type { RunRow, ThreadEffort } from "../../shared/thread";
import type { AccountView, ChatTarget, CodexAccountView } from "./api";
import {
  effortChipLabel, effortFooter, effortMenuBlocked, effortOptions, newSessionEffort, newSessionEffortBlock, newSessionEffortHint,
  accountMenuBlocked, claudeAccountOptions, codexAccountOptions, harnessOptions, modelMenuBlocked, modelOptions,
  awaitingTargetText, modelLabel, switchBlocked, switchErrorText, switchResultText,
} from "./switchView";
import { CHAT_MODELS } from "../../shared/chatModels";
// Tests may import devd (see newSession.test.ts): the model list is the one devd accepts.
import { CHAT_MODELS as DEVD_CHAT_MODELS } from "../../devd/src/chatSwitch";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const CLAUDE: ChatTarget = { agent: "claude", harness: "claude", account: "primary", model: "claude-opus-5-5", awaitingTarget: false, bridgeVersion: "1.2.0" };
const CODEX: ChatTarget = { agent: "codex", harness: "codex", account: "default", model: null, awaitingTarget: false, bridgeVersion: "1.2.0" };

const run = (over: Partial<RunRow>): RunRow => ({
  runId: "r", origin: "user", status: "completed", nativeThreadId: null, model: null, harness: "claude",
  queuedAt: 0, startedAt: 0, endedAt: 1, endedSeq: 2, usage: null, error: null, ...over,
});

const account = (id: string, over: Partial<AccountView> = {}): AccountView => ({
  id, label: `${id}@example.com`, disabled: false, quarantined: false,
  fiveHourPct: 30, fiveHourResetsAt: NOW + HOUR, sevenDayPct: 10, sevenDayResetsAt: NOW + 50 * HOUR,
  limits: [], fetchedAt: NOW, error: null, errorCount: 0, orgId: null, observedOrgId: null, leases: [], ...over,
});

const codex = (id: string, over: Partial<CodexAccountView> = {}, usage: Partial<NonNullable<CodexAccountView["usage"]>> = {}): CodexAccountView => ({
  id, label: id, isDefault: id === "default", disabled: false,
  usage: {
    state: "ok", planType: "pro", credits: null, limitReached: null, fetchedAt: NOW, error: null,
    windows: [{ kind: "primary", usedPct: 40, windowMinutes: 300, resetsAt: NOW + HOUR }, { kind: "secondary", usedPct: 12, windowMinutes: 10080, resetsAt: NOW + 90 * HOUR }],
    ...usage,
  },
  ...over,
});

test("switching is blocked while a run is active or a message is queued (devd answers 409 run-active)", () => {
  expect(switchBlocked({ runs: [run({})] }, CLAUDE)).toBeNull();
  expect(switchBlocked({ runs: [run({}), run({ status: "running", endedSeq: null })] }, CLAUDE)).toMatch(/run is active/);
  expect(switchBlocked({ runs: [run({ status: "queued", endedSeq: null })] }, CLAUDE)).toMatch(/queued/);
  expect(awaitingTargetText(CLAUDE)).toBeNull();
});

test("P24a: while the agent waits for a target, switching is allowed despite queued messages and the reason says so", () => {
  const waiting = { ...CLAUDE, awaitingTarget: true };
  expect(switchBlocked({ runs: [run({ status: "queued", endedSeq: null })] }, waiting)).toBeNull();
  expect(awaitingTargetText(waiting)).toMatch(/waiting for a target/);
});

test("model menu: the models devd accepts for the current harness, the current one marked", () => {
  expect(modelOptions(CLAUDE).map((o) => o.value)).toEqual([...DEVD_CHAT_MODELS.claude]);
  expect(modelOptions(CODEX).map((o) => o.value)).toEqual([...DEVD_CHAT_MODELS.codex]);
  const vibe: ChatTarget = { agent: "vibe", harness: "vibe", account: null, model: "mistral-large-4-0", awaitingTarget: false, bridgeVersion: "1.2.0" };
  expect(modelOptions(vibe).map((o) => [o.value, o.current])).toEqual(DEVD_CHAT_MODELS.vibe.map((m) => [m, m === "mistral-large-4-0"]));
  // After session/load Vibe reports Medium 3.5 as mistral-medium-latest: the alias table marks it, nothing fuzzier.
  expect(modelOptions({ ...vibe, model: "mistral-medium-latest" }).filter((o) => o.current).map((o) => o.value)).toEqual(["mistral-medium-3.5"]);
  expect(modelOptions({ ...vibe, model: "mistral-medium" }).some((o) => o.current)).toBe(false);
  expect(modelOptions(CLAUDE).filter((o) => o.current).map((o) => o.value)).toEqual(["claude-opus-5-5"]);
  // A reported variant is not one of the offered ids: nothing is marked, every model can be picked.
  expect(modelOptions({ ...CLAUDE, model: "claude-opus-5-5-high" }).some((o) => o.current || o.disabled)).toBe(false);
});

test("model menu: a proxy profile's model comes from settings, so the menu is blocked with the reason", () => {
  expect(modelMenuBlocked(CLAUDE)).toBeNull();
  expect(modelMenuBlocked({ ...CLAUDE, agent: "claude-gemini", model: "gemini-x" })).toMatch(/Claude Code \+ Gemini.*settings/);
});

test("account menu: a proxy profile runs on no account pool", () => {
  expect(accountMenuBlocked(CLAUDE)).toBeNull();
  expect(accountMenuBlocked(CODEX)).toBeNull();
  expect(accountMenuBlocked({ ...CLAUDE, agent: "claude-gemini", account: null })).toMatch(/no account pool/);
  // An ACP agent runs on its own CLI login (devd: 400 no-account-pool).
  expect(accountMenuBlocked({ agent: "vibe", harness: "vibe", account: null, model: null, awaitingTarget: false, bridgeVersion: "1.2.0" })).toMatch(/no account pool/);
});

test("Claude accounts: quarantined, disabled and expired are disabled with the reason; over the threshold stays enabled with a warning (P15)", () => {
  const opts = claudeAccountOptions([
    account("primary"),
    account("jailed", { quarantined: true }),
    account("off", { disabled: true }),
    account("expired", { error: "HTTP 401", fiveHourPct: null, sevenDayPct: null }),
    account("full", { fiveHourPct: 97 }),
    account("reset", { fiveHourPct: 99, fiveHourResetsAt: NOW - 1 }),
  ], 90, NOW, CLAUDE);
  const by = Object.fromEntries(opts.map((o) => [o.value, o]));
  expect(by.primary).toMatchObject({ current: true, disabled: null, warning: null, detail: "5h 30% · 7d 10%" });
  expect(by.jailed.disabled).toMatch(/quarantined/i);
  expect(by.off.disabled).toMatch(/disabled/i);
  expect(by.expired.disabled).toMatch(/HTTP 401/);
  expect(by.full).toMatchObject({ disabled: null, warning: "over limit (97%)" });
  // A window whose reset passed is not over the limit any more (devd's isExhausted).
  expect(by.reset.warning).toBeNull();
});

test("Codex accounts: disabled, signed out and a rejected login are disabled; a live limit is a warning", () => {
  const opts = codexAccountOptions([
    codex("default"),
    codex("off", { disabled: true }),
    codex("out", {}, { state: "signed-out" }),
    codex("rejected", {}, { state: "error", error: "HTTP 401 Unauthorized" }),
    codex("flaky", {}, { state: "error", error: "HTTP 503" }),
    codex("limit", {}, { limitReached: "primary", windows: [{ kind: "primary", usedPct: 100, windowMinutes: 300, resetsAt: NOW + HOUR }] }),
    codex("limit-reset", {}, { limitReached: "primary", windows: [{ kind: "primary", usedPct: 100, windowMinutes: 300, resetsAt: NOW - 1 }] }),
  ], NOW, CODEX);
  const by = Object.fromEntries(opts.map((o) => [o.value, o]));
  expect(by.default).toMatchObject({ current: true, disabled: null, warning: null, detail: "5h 40% · 7d 12%" });
  expect(by.off.disabled).toMatch(/disabled/i);
  expect(by.out.disabled).toMatch(/signed out/i);
  expect(by.rejected.disabled).toMatch(/rejected/i);
  // devd's codexAccountUsable allows a transient error.
  expect(by.flaky.disabled).toBeNull();
  expect(by.limit).toMatchObject({ disabled: null, warning: "over limit (100%)" });
  expect(by["limit-reset"].warning).toBeNull();
});

test("harness menu: every profile chat can run is enabled, the others carry devd's reason", () => {
  const opts = harnessOptions(CLAUDE);
  const by = Object.fromEntries(opts.map((o) => [o.value, o]));
  expect(by.claude).toMatchObject({ current: true, disabled: null, label: "Claude Code" });
  expect(by.codex.disabled).toBeNull();
  expect(by["claude-gemini"].disabled).toBeNull();
  expect(by.grok).toMatchObject({ disabled: null, label: "Grok Build" });
  expect(by.antigravity.disabled).toMatch(/not available in chat/);
  expect(by.vibe).toMatchObject({ disabled: null, label: "Mistral Vibe" });
});

test("harness menu: a bridge older than 1.2.0 cannot take an ACP agent, as devd says (409 bridge-too-old)", () => {
  const old = Object.fromEntries(harnessOptions({ ...CLAUDE, bridgeVersion: "1.1.0" }).map((o) => [o.value, o]));
  expect(old.vibe.disabled).toBe("recreate the container to use Mistral Vibe");
  expect(old.codex.disabled).toBeNull();
  // No handshake yet: devd decides when the bridge is connected.
  expect(Object.fromEntries(harnessOptions({ ...CLAUDE, bridgeVersion: null }).map((o) => [o.value, o])).vibe.disabled).toBeNull();
});

test("switch errors are spelled out, never swallowed", () => {
  expect(switchErrorText(409, { error: "run-active" })).toMatch(/run is active/);
  expect(switchErrorText(409, { error: "switch-in-progress" })).toMatch(/already in progress/);
  expect(switchErrorText(409, { error: "unknown-model-window", message: "the context window of model x-9 is unknown to devd" })).toMatch(/x-9/);
  expect(switchErrorText(400, { error: "invalid-account", message: "that account does not exist or is disabled/quarantined" })).toMatch(/disabled\/quarantined/);
  expect(switchErrorText(409, { error: "agent-disconnected" })).toMatch(/not connected/);
  expect(switchErrorText(504, { error: "agent-timeout" })).toMatch(/may have happened/);
  expect(switchErrorText(409, { error: "command-failed", message: "bridge said no" })).toMatch(/bridge said no/);
  expect(switchErrorText(409, { error: "no-account" })).toMatch(/no-account/);
  expect(switchErrorText(502, null)).toBe("HTTP 502");
});

test("switch results: unchanged and an exhausted account are said, a plain switch shows in the thread", () => {
  expect(switchResultText({ kind: "set-model", unchanged: true })).toMatch(/already/i);
  expect(switchResultText({ kind: "restart-resume", exhausted: true })).toMatch(/over its usage limit/);
  expect(switchResultText({ kind: "fresh-with-handoff" })).toBeNull();
});

test("model label: known families read as names, efforts and dated snapshots included; unknown ids stay the raw id", () => {
  expect(modelLabel("claude-opus-5-5")).toBe("Opus 5.5");
  expect(modelLabel("claude-sonnet-5-5-high")).toBe("Sonnet 5.5 High");
  expect(modelLabel("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
  expect(modelLabel("gpt-6.1-sol")).toBe("GPT-6.1 Sol");
  expect(modelLabel("gpt-5.4-mini-2026-03-17")).toBe("GPT-5.4 Mini");
  expect(modelLabel("gpt-5.3-codex")).toBe("GPT-5.3 Codex");
  expect(modelLabel("grok-4.7-build-fast")).toBe("Grok 4.7 Build Fast");
  expect(modelLabel("mistral-large-4-0")).toBe("Mistral Large 4.0");
  expect(modelLabel("mistral-medium-latest")).toBe("Mistral Medium 3.5");
  expect(modelLabel("gemini-4-neon")).toBe("Gemini 4 Neon");
  expect(modelLabel("claude-opus-5-5[1m]")).toBe("claude-opus-5-5[1m]");
  expect(modelLabel("llama-9")).toBe("llama-9");
  expect(modelLabel("claude")).toBe("claude");
  // Every model the menus offer gets a readable name.
  for (const id of Object.values(CHAT_MODELS).flat()) expect(modelLabel(id)).not.toBe(id);
});

describe("effort (bridge 1.7.0)", () => {
  const eff = (o: Partial<ThreadEffort> = {}): ThreadEffort => ({ model: "claude-opus-5-5", supported: ["low", "medium", "high", "xhigh", "max"], effective: null, chosen: null, ...o });
  const NEW = { bridgeVersion: "1.7.0" }, OLD = { bridgeVersion: "1.6.0" };

  test("chip: the level the agent reported, else the choice, else Default; nothing for an agent without levels", () => {
    expect(effortChipLabel(eff({ chosen: "max", effective: "high" }), NEW)).toBe("High");
    expect(effortChipLabel(eff({ chosen: "high", effective: "high" }), NEW)).toBe("High");
    expect(effortChipLabel(eff({ effective: "medium" }), NEW)).toBe("Medium");
    expect(effortChipLabel(eff(), NEW)).toBe("Default");
    expect(effortChipLabel(eff({ chosen: "xhigh" }), NEW)).toBe("Extra high");
    expect(effortChipLabel(eff({ supported: [] }), NEW)).toBeNull();
    expect(effortChipLabel(null, NEW)).toBeNull();
    expect(effortChipLabel(eff({ chosen: "high" }), OLD)).toBeNull();
  });

  test("menu: Default first with what it runs at, then each level the model lists, the current one ticked", () => {
    const o = effortOptions(eff({ chosen: "high", effective: "high" }));
    expect(o.map((x) => [x.value, x.label, x.current])).toEqual([
      ["", "Default", false], ["low", "Low", false], ["medium", "Medium", false], ["high", "High", true], ["xhigh", "Extra high", false], ["max", "Max", false],
    ]);
    expect(effortOptions(eff({ effective: "medium", supported: ["low", "medium"] }))[0]).toMatchObject({ current: true, detail: "Medium for claude-opus-5-5" });
    // Claude's default is known only from a reply's level: never guessed.
    expect(effortOptions(eff())[0]!.detail).toBe("The level shows after the agent's first reply");
  });

  test("menu blocked: an old bridge says what to do, unknown levels and a model without levels say so", () => {
    expect(effortMenuBlocked(eff(), OLD)).toBe("This session's agent bridge (1.6.0) cannot change the effort: recreate the session's container");
    expect(effortMenuBlocked(eff(), { bridgeVersion: null })).toBe("This session's agent bridge (unknown version) cannot change the effort: recreate the session's container");
    expect(effortMenuBlocked(null, NEW)).toBe("The agent has not reported its effort levels yet");
    expect(effortMenuBlocked(eff({ supported: null }), NEW)).toBe("The agent has not reported the effort levels of claude-opus-5-5");
    expect(effortMenuBlocked(eff({ supported: [] }), NEW)).toBe("claude-opus-5-5 has no effort levels");
    expect(effortMenuBlocked(eff(), NEW)).toBeNull();
  });

  test("before the model's levels are known (bridge 1.8.0): the unchecked levels are offered, checked on the next message", () => {
    const early = eff({ model: null, supported: null, unchecked: ["low", "medium", "high", "xhigh", "max"], chosen: "xhigh" });
    expect(effortMenuBlocked(early, NEW)).toBeNull();
    expect(effortOptions(early).map((x) => [x.value, x.current])).toEqual([["", false], ["low", false], ["medium", false], ["high", false], ["xhigh", true], ["max", false]]);
    expect(effortChipLabel(early, NEW)).toBe("Extra high");
    expect(effortFooter(early)).toBe("Applies from your next message, which checks it against the model.");
    expect(effortFooter(eff())).toBe("Applies from your next message.");
  });
});

test("effort on /new: offered for Claude in a chat session only, and set with the first message", () => {
  expect(newSessionEffort("claude", "chat")).not.toBeNull();
  expect(newSessionEffort("claude", "chat")!.map((o) => o.value)).toEqual(["", "low", "medium", "high", "xhigh", "max"]);
  expect(newSessionEffort("claude", "tmux")).toBeNull();
  expect(newSessionEffort("claude", null)).toBeNull();
  expect(newSessionEffort("codex", "chat")).toBeNull();
  expect(newSessionEffortBlock("", "high")).toBe("Effort is set with your first message: type one, or set it back to Default.");
  expect(newSessionEffortBlock("fix it", "high")).toBeNull();
  expect(newSessionEffortBlock("", null)).toBeNull();
});

test("effort hint on /new: Codex's levels come with its session, so the line says where to set it", () => {
  expect(newSessionEffortHint("codex", "chat")).toBe("Effort: set it in the thread once it opens");
  expect(newSessionEffortHint("codex", "tmux")).toBeNull();
  expect(newSessionEffortHint("claude", "chat")).toBeNull();
});
