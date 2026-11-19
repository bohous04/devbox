import { expect, test } from "bun:test";
import type { RunRow } from "../../shared/thread";
import type { AccountView, ChatTarget, CodexAccountView } from "./api";
import {
  accountMenuBlocked, claudeAccountOptions, codexAccountOptions, harnessOptions, modelMenuBlocked, modelOptions,
  switchBlocked, switchErrorText, switchResultText,
} from "./switchView";
// Tests may import devd (see newSession.test.ts): the model list is the one devd accepts.
import { CHAT_MODELS as DEVD_CHAT_MODELS } from "../../devd/src/chatSwitch";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const CLAUDE: ChatTarget = { agent: "claude", harness: "claude", account: "primary", model: "claude-opus-5-5" };
const CODEX: ChatTarget = { agent: "codex", harness: "codex", account: "default", model: null };

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
  expect(switchBlocked({ runs: [run({})] })).toBeNull();
  expect(switchBlocked({ runs: [run({}), run({ status: "running", endedSeq: null })] })).toMatch(/run is active/);
  expect(switchBlocked({ runs: [run({ status: "queued", endedSeq: null })] })).toMatch(/queued/);
});

test("model menu: the models devd accepts for the current harness, the current one marked", () => {
  expect(modelOptions(CLAUDE).map((o) => o.value)).toEqual([...DEVD_CHAT_MODELS.claude]);
  expect(modelOptions(CODEX).map((o) => o.value)).toEqual([...DEVD_CHAT_MODELS.codex]);
  expect(modelOptions(CLAUDE).filter((o) => o.current).map((o) => o.value)).toEqual(["claude-opus-5-5"]);
  // A reported variant is not one of the offered ids: nothing is marked, every model can be picked.
  expect(modelOptions({ ...CLAUDE, model: "claude-opus-5-5-high" }).some((o) => o.current || o.disabled)).toBe(false);
});

test("model menu: a proxy profile's model comes from settings, so the menu is blocked with the reason", () => {
  expect(modelMenuBlocked(CLAUDE)).toBeNull();
  expect(modelMenuBlocked({ ...CLAUDE, agent: "claude-gpt", model: "gpt-x" })).toMatch(/Claude Code \+ GPT.*settings/);
});

test("account menu: a proxy profile runs on no account pool", () => {
  expect(accountMenuBlocked(CLAUDE)).toBeNull();
  expect(accountMenuBlocked(CODEX)).toBeNull();
  expect(accountMenuBlocked({ ...CLAUDE, agent: "claude-grok", account: null })).toMatch(/no account pool/);
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
  expect(by["claude-gpt"].disabled).toBeNull();
  expect(by.grok.disabled).toMatch(/not available in chat/);
  expect(by.antigravity.disabled).toMatch(/not available in chat/);
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
