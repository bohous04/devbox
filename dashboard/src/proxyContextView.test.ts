import { expect, test } from "bun:test";
import { formatTokens, parseTokens, sourceHint, type ProxyContextRow } from "./proxyContextView";

const row = (over: Partial<ProxyContextRow>): ProxyContextRow =>
  ({ key: "gpt", label: "Claude Code + GPT", override: null, effective: 1_000_000, source: "default", ...over });

// Input also accepts k/M shorthands, as cc writes them in docs (`950k`, `1M`). Nonsense returns
// null — Save is then not offered at all, instead of saving something other than what the person
// typed.
test("parseTokens: numbers and k/M shorthands, nonsense → null", () => {
  expect(parseTokens("1000000")).toBe(1_000_000);
  expect(parseTokens(" 400k ")).toBe(400_000);
  expect(parseTokens("1M")).toBe(1_000_000);
  expect(parseTokens("1.5m")).toBe(1_500_000);
  expect(parseTokens("")).toBeNull();
  expect(parseTokens("lots")).toBeNull();
  expect(parseTokens("0")).toBeNull();
  expect(parseTokens("-5")).toBeNull();
});

test("formatTokens: thousands separators, null → —", () => {
  expect(formatTokens(1_048_576)).toBe("1,048,576");
  expect(formatTokens(null)).toBe("—");
});

// The hint says WHERE the value comes from — manual/default/catalog are fixed in different places and ways.
// "unknown" must reveal the consequence (cc assumes 200k), not just state it is unknown.
test("sourceHint describes the origin of the value", () => {
  expect(sourceHint(row({ source: "manual" }))).toBe("manual override");
  expect(sourceHint(row({ source: "default" }))).toBe("1M default — real window unknown");
  expect(sourceHint(row({ source: "catalog" }))).toBe("auto from the OpenRouter catalog");
  expect(sourceHint(row({ source: "unknown", effective: null }))).toBe("unknown — Claude Code assumes 200k");
});
