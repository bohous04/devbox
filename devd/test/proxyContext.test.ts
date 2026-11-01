import { expect, test } from "bun:test";
import { DEFAULT_CONFIG, type Settings } from "../src/config";
import { proxyContextRows } from "../src/proxyContext";
import { CLIPROXY_DEFAULT_CTX } from "../src/sessions";

const settings = (over: Partial<Settings> = {}): Settings => ({ ...DEFAULT_CONFIG.settings, ...over });

test("rows for all four proxy profiles, with labels from agents.ts", async () => {
  const rows = await proxyContextRows(settings(), async () => null);
  expect(rows.map((r) => r.key)).toEqual(["gpt", "grok", "gemini", "openrouter"]);
  expect(rows.find((r) => r.key === "gpt")?.label).toBe("Claude Code + GPT");
});

test("cliproxy without override = 1M default, openrouter with a model = catalog", async () => {
  const rows = await proxyContextRows(settings({ proxyModels: { openrouter: "stealth/ox-alpha" } }),
    async (m) => (m === "stealth/ox-alpha" ? 1048576 : null));
  expect(rows.find((r) => r.key === "gpt")).toMatchObject({ override: null, effective: CLIPROXY_DEFAULT_CTX, source: "default" });
  expect(rows.find((r) => r.key === "openrouter")).toMatchObject({ override: null, effective: 1048576, source: "catalog" });
});

test("a manual override wins and reports itself as manual", async () => {
  const rows = await proxyContextRows(settings({ proxyContext: { grok: 2_000_000 } }), async () => null);
  expect(rows.find((r) => r.key === "grok")).toMatchObject({ override: 2_000_000, effective: 2_000_000, source: "manual" });
});

test("openrouter without a model or without a catalog = unknown, effective null", async () => {
  const noModel = await proxyContextRows(settings(), async () => 999);
  expect(noModel.find((r) => r.key === "openrouter")).toMatchObject({ effective: null, source: "unknown" });
  const lookupFail = await proxyContextRows(settings({ proxyModels: { openrouter: "m" } }), async () => null);
  expect(lookupFail.find((r) => r.key === "openrouter")).toMatchObject({ effective: null, source: "unknown" });
});
