import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { AGENT_LOGOS, logoForAgent, markSize } from "./agentLogos";

/** The Apple apps draw the same marks: their template SVGs (ios/DevboxApp/Assets.xcassets/AgentLogos) hold these paths. */
test("agent logos: the Apple asset catalog holds the same paths", () => {
  for (const [name, l] of Object.entries(AGENT_LOGOS)) {
    const svg = readFileSync(new URL(`../../../ios/DevboxApp/Assets.xcassets/AgentLogos/agent-${name}.imageset/agent-${name}.svg`, import.meta.url), "utf8");
    expect([name, svg.match(/ d="([^"]+)"/)?.[1], svg.match(/fill-rule="([^"]+)"/)?.[1], svg.match(/viewBox="([^"]+)"/)?.[1],
      svg.match(/<path/g)?.length])
      .toEqual([name, l.path, "evenodd", l.box.join(" "), 1]);
  }
});

test("agent logos: brand colours are off", () => {
  for (const l of Object.values(AGENT_LOGOS)) expect(l.brand).toBe(false);
});

test("agent logos: each agent's mark, and the ring for one this dashboard does not know", () => {
  expect(["claude", "claude-openrouter", "codex", "grok", "antigravity", "vibe", "gpt", "toString"].map(logoForAgent))
    .toEqual(["claude", "claude", "openai", "grok", "antigravity", "mistral", "generic", "generic"]);
});

/** The Apple view sizes each mark by its own table of proportions (AgentLogo.swift `aspect`): the same boxes. */
test("agent logos: the Apple aspect table matches the boxes", () => {
  const swift = readFileSync(new URL("../../../ios/DevboxApp/Support/AgentLogo.swift", import.meta.url), "utf8");
  const table = swift.slice(swift.indexOf("var aspect: Double"), swift.indexOf("var optical: Double"));
  const aspect = new Map<string, number>();
  for (const m of table.matchAll(/case ([^:]+): ([\d.]+)(?: \/ ([\d.]+))?/g)) {
    for (const c of m[1].split(",")) aspect.set(c.trim().replace(/^\./, ""), m[3] ? Number(m[2]) / Number(m[3]) : Number(m[2]));
  }
  for (const [name, l] of Object.entries(AGENT_LOGOS)) expect([name, aspect.get(name)]).toEqual([name, l.box[2] / l.box[3]]);
});

/** And its optical scales (AgentLogo.swift `optical`) are the web's. */
test("agent logos: the Apple optical scales match", () => {
  const swift = readFileSync(new URL("../../../ios/DevboxApp/Support/AgentLogo.swift", import.meta.url), "utf8");
  const table = swift.slice(swift.indexOf("var optical: Double"), swift.indexOf("var showsBrand"));
  const optical = new Map<string, number>();
  for (const m of table.matchAll(/case ([^:]+): ([\d.]+)/g)) for (const c of m[1].split(",")) optical.set(c.trim().replace(/^\./, ""), Number(m[2]));
  for (const [name, l] of Object.entries(AGENT_LOGOS)) expect([name, optical.get(name)]).toEqual([name, l.optical]);
});

test("agent logos: every mark takes the slot's area (times its optical scale), in its own proportions", () => {
  for (const name of Object.keys(AGENT_LOGOS) as (keyof typeof AGENT_LOGOS)[]) {
    const { width, height } = markSize(name, 11);
    const { box: [, , w, h], optical } = AGENT_LOGOS[name];
    expect([name, Math.round(width * height * 100) / 100, Math.round((width / height) * 1000) / 1000])
      .toEqual([name, Math.round(121 * optical * optical * 100) / 100, Math.round((w / h) * 1000) / 1000]);
  }
  expect(markSize("mistral", 11).height).toBeLessThan(11);
  expect(markSize("mistral", 11).width).toBeGreaterThan(11);
});
