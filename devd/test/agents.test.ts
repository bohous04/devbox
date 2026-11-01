import { expect, test } from "bun:test";
import { AGENTS, AGENT_IDS, AGENT_RUNTIMES, isAgentName, RUNTIME_BIN, specFor, usesProxy } from "../src/agents";
import { isAgentName as fromDb, type AgentName } from "../src/db";

test("eight profiles, each with a label and a known runtime", () => {
  expect(AGENT_IDS).toEqual(["claude", "claude-gpt", "claude-grok", "claude-gemini", "claude-openrouter", "codex", "grok", "antigravity"]);
  for (const id of AGENT_IDS) {
    expect(AGENTS[id].label.length).toBeGreaterThan(0);
    expect(AGENTS[id].short.length).toBeGreaterThan(0);
    expect(RUNTIME_BIN[AGENTS[id].runtime]).toBeTruthy();
  }
});

// runtime = process name in `ps` (watchdog, agent switch). agy is a native binary,
// `ps -eo comm=` shows exactly `agy` (evidence: the Gemini research notes, question 6.3).
test("antigravity: its own runtime agy, wrapper ag, outside the Anthropic account and the proxy", () => {
  expect(AGENTS.antigravity.runtime).toBe("agy");
  expect(RUNTIME_BIN.agy).toBe("ag");
  expect(AGENTS.antigravity.short).toBe("Antigravity");
  expect(AGENTS.antigravity.anthropicAccount).toBe(false);
  expect(usesProxy("antigravity")).toBe(false);
});

test("AGENT_RUNTIMES contains agy (the watchdog counts it as work)", () => {
  expect(AGENT_RUNTIMES).toContain("agy");
});

test("short names keep the current notification text unchanged", () => {
  expect(AGENTS.claude.short).toBe("Claude");
  expect(AGENTS.codex.short).toBe("Codex");
});

test("ONLY native claude runs on the Anthropic account", () => {
  const onAccount = AGENT_IDS.filter((id) => AGENTS[id].anthropicAccount);
  expect(onAccount).toEqual(["claude"]);
});

test("exactly four profiles need the proxy and all have a modelKey", () => {
  const proxy = AGENT_IDS.filter(usesProxy);
  expect(proxy).toEqual(["claude-gpt", "claude-grok", "claude-gemini", "claude-openrouter"]);
  for (const id of proxy) expect(AGENTS[id].modelKey).toBeTruthy();
  // proxy profiles run in Claude Code, not in their own binary
  for (const id of proxy) expect(AGENTS[id].runtime).toBe("claude");
});

// `modelKey` says WHICH model, `upstream` WHERE to go for it. They used to be one and the same
// (everything went through CLIProxyAPI), so the URL and key were hard-coded. OpenRouter goes
// direct, so a hardcode would send it to the proxy with a key the proxy does not know — 401.
test("every proxy profile has an upstream, native profiles none", () => {
  for (const id of AGENT_IDS) {
    if (usesProxy(id)) expect(AGENTS[id].upstream).toBeTruthy();
    else expect(AGENTS[id].upstream).toBeUndefined();
  }
  expect(AGENTS["claude-gpt"].upstream).toBe("cliproxy");
  expect(AGENTS["claude-grok"].upstream).toBe("cliproxy");
  expect(AGENTS["claude-gemini"].upstream).toBe("cliproxy");
  expect(AGENTS["claude-openrouter"].upstream).toBe("openrouter");
});

test("isAgentName accepts all profiles and nothing else; db only re-exports it", () => {
  for (const id of AGENT_IDS) expect(isAgentName(id)).toBe(true);
  expect(isAgentName("gpt")).toBe(false);
  expect(isAgentName(undefined)).toBe(false);
  expect(fromDb).toBe(isAgentName);
  const a: AgentName = "grok";   // type check: the db re-export carries the new union
  expect(isAgentName(a)).toBe(true);
});

// `agent` is plain text in the DB and also comes from the API — the AgentName type is a promise, not a guarantee.
// `AGENTS[s.agent ?? "claude"].anthropicAccount` therefore crashed on an unknown value
// (500 in devd, a blank page in the dashboard) where the earlier `=== "codex"` just
// returned false. The fallback restores that totality.
test("specFor: unknown value, null and undefined fall back to claude", () => {
  expect(specFor("gpt")).toBe(AGENTS.claude);
  expect(specFor("")).toBe(AGENTS.claude);
  expect(specFor(null)).toBe(AGENTS.claude);
  expect(specFor(undefined)).toBe(AGENTS.claude);
  expect(specFor("constructor")).toBe(AGENTS.claude);   // inherited properties are not profiles
  for (const id of AGENT_IDS) expect(specFor(id)).toBe(AGENTS[id]);
});

test("usesProxy does not treat an unknown value as proxy and does not crash", () => {
  expect(usesProxy("nesmysl" as never)).toBe(false);
});
