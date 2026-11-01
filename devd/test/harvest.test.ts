import { expect, test, beforeEach } from "bun:test";
import { usageMetricRows } from "../src/harvest";
import { resetPricingWarnings } from "../src/pricing";

beforeEach(() => resetPricingWarnings());

const ev = (over = {}) => ({
  ts: 1_000, model: "grok-4.6", agent: "grok" as const, sourceId: "test-conversation",
  session: { id: "dev-p-r", project: "p", repo: "r" },
  totals: { input: 1_000_000, cacheRead: 2_000_000, cacheWrite: 0, output: 500_000 },
  promptTokens: 3_000_000, ...over,
});

test("tokens + cost, types as in cc, long-context rate by promptTokens", () => {
  const rows = usageMetricRows(ev());
  const tok = rows.filter((r) => r.name === "claude_code.token.usage");
  expect(tok.map((r) => JSON.parse(r.attrs).type).sort()).toEqual(["cacheRead", "input", "output"]); // zero kinds are left out
  const cost = rows.filter((r) => r.name === "claude_code.cost.usage");
  // 3M prompt ≥ 200k → long-context: 1M×$4 + 2M×$1 + 0.5M×$12 = 4+2+6
  expect(cost.reduce((s, r) => s + r.value, 0)).toBeCloseTo(12);
  for (const r of rows) {
    expect(r.session_id).toBe("dev-p-r");
    const a = JSON.parse(r.attrs);
    expect(a["devbox.session.id"]).toBe("dev-p-r");
    expect(a.project).toBe("p"); expect(a.repo).toBe("r");
    expect(a["devbox.host"]).toBe("devbox");
    expect(a.model).toBe("grok-4.6");
    expect(a["devbox.agent"]).toBe("grok");
    expect(a["devbox.usage.source_id"]).toBe("test-conversation");
  }
});

test("without a session: rows without session_id/project — counted at least per model", () => {
  const rows = usageMetricRows(ev({ session: null }));
  expect(rows.length).toBeGreaterThan(0);
  for (const r of rows) {
    expect(r.session_id).toBeNull();
    expect(JSON.parse(r.attrs).project).toBeUndefined();
  }
});

test("without a model: only tokens without the model attribute, no cost", () => {
  const rows = usageMetricRows(ev({ model: null }));
  expect(rows.every((r) => r.name === "claude_code.token.usage")).toBe(true);
  expect(JSON.parse(rows[0].attrs).model).toBeUndefined();
});

test("cacheWrite → cacheCreation mapping + cost for gpt-5.6-sol", () => {
  const rows = usageMetricRows(ev({ model: "gpt-5.6-sol", promptTokens: 100_000, totals: { input: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000, output: 500_000 } }));
  const tok = rows.filter((r) => r.name === "claude_code.token.usage");
  expect(tok.map((r) => JSON.parse(r.attrs).type).sort()).toEqual(["cacheCreation", "cacheRead", "input", "output"]);
  const cacheCreationRows = tok.filter((r) => JSON.parse(r.attrs).type === "cacheCreation");
  expect(cacheCreationRows).toHaveLength(1);
  expect(cacheCreationRows[0].value).toBe(1_000_000);
  // gpt-5.6-sol: input $4 + cacheRead $0.4 + cacheWrite $5 + output $10 = $19.4
  const cost = rows.filter((r) => r.name === "claude_code.cost.usage");
  expect(cost.reduce((s, r) => s + r.value, 0)).toBeCloseTo(19.4);
});

test("a model without a price: tokens yes, cost no", () => {
  const seen: string[] = [];
  const orig = console.warn; console.warn = (m: string) => { seen.push(m); };
  try {
    const rows = usageMetricRows(ev({ model: "mystery-9" }));
    expect(rows.some((r) => r.name === "claude_code.cost.usage")).toBe(false);
    expect(rows.some((r) => r.name === "claude_code.token.usage")).toBe(true);
  } finally {
    console.warn = orig;
  }
  expect(seen.length).toBeGreaterThan(0); // warn was called
});
