import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { AGENT_LOGOS, logoForAgent } from "./agentLogos";

/** The Apple apps draw the same marks: their template SVGs (ios/DevboxApp/Assets.xcassets/AgentLogos) hold these paths. */
test("agent logos: the Apple asset catalog holds the same paths", () => {
  for (const [name, l] of Object.entries(AGENT_LOGOS)) {
    const svg = readFileSync(new URL(`../../../ios/DevboxApp/Assets.xcassets/AgentLogos/agent-${name}.imageset/agent-${name}.svg`, import.meta.url), "utf8");
    expect([name, svg.match(/ d="([^"]+)"/)?.[1], svg.match(/fill-rule="([^"]+)"/)?.[1]]).toEqual([name, l.path, l.rule]);
  }
});

test("agent logos: brand colours are off", () => {
  for (const l of Object.values(AGENT_LOGOS)) expect(l.brand).toBe(false);
});

test("agent logos: each agent's mark, and the ring for one this dashboard does not know", () => {
  expect(["claude", "claude-openrouter", "codex", "grok", "antigravity", "vibe", "gpt", "toString"].map(logoForAgent))
    .toEqual(["claude", "claude", "generic", "generic", "gemini", "mistral", "generic", "generic"]);
});
