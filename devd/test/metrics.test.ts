import { expect, test, beforeEach } from "bun:test";
import { openDb, insertMetrics } from "../src/db";
import { costIsMeaningful, parseOtlpMetrics, pointsToRows, resetCostWarnings, type DataPoint } from "../src/metrics";
import { resetPricingWarnings } from "../src/pricing";

beforeEach(() => { resetCostWarnings(); resetPricingWarnings(); });

// Resource attrs use devbox's own non-colliding keys (`devbox.session.id`, `project`),
// set via OTEL_RESOURCE_ATTRIBUTES in sessions.ts runOpts. Claude Code's own telemetry
// additionally emits a datapoint-level `session.id` (its conversation UUID) — the
// "input" datapoint below pins that this must NOT override devbox's session id.
const payload = {
  resourceMetrics: [{
    resource: { attributes: [
      { key: "devbox.session.id", value: { stringValue: "dev-shop-cms" } },
      { key: "project", value: { stringValue: "shop" } },
    ] },
    scopeMetrics: [{
      metrics: [
        { name: "claude_code.token.usage", sum: { dataPoints: [
          { asInt: "1500", timeUnixNano: "1720000000000000000", attributes: [
            { key: "type", value: { stringValue: "input" } },
            { key: "session.id", value: { stringValue: "claude-own-conversation-uuid" } },
          ] },
          { asInt: "800", timeUnixNano: "1720000000000000000", attributes: [{ key: "type", value: { stringValue: "output" } }] },
        ]}},
        { name: "claude_code.cost.usage", sum: { dataPoints: [
          { asDouble: 0.0123, timeUnixNano: "1720000000000000000", attributes: [] },
        ]}},
        { name: "junk.histogram", histogram: { dataPoints: [{ count: "3" }] } },
      ],
    }],
  }],
};

test("parseOtlpMetrics flattens sum/gauge points with merged resource attrs", () => {
  const pts = parseOtlpMetrics(payload);
  expect(pts).toHaveLength(3); // 2 token + 1 cost; histogram ignored
  const input = pts.find((p) => p.name === "claude_code.token.usage" && p.attributes.type === "input")!;
  expect(input.value).toBe(1500);
  expect(input.attributes["devbox.session.id"]).toBe("dev-shop-cms");
  expect(input.attributes.project).toBe("shop");
  expect(input.attributes["session.id"]).toBe("claude-own-conversation-uuid"); // Claude's own attr, merged but not used for our session_id
  expect(pts.find((p) => p.name === "claude_code.cost.usage")!.value).toBeCloseTo(0.0123);
});

test("pointsToRows extracts session_id from devbox.session.id, not Claude's own session.id", () => {
  const rows = pointsToRows(parseOtlpMetrics(payload));
  expect(rows[0].session_id).toBe("dev-shop-cms"); // not "claude-own-conversation-uuid"
  expect(rows.every((r) => r.session_id === "dev-shop-cms")).toBe(true);
  expect(rows[0].ts).toBe(1720000000000);
  const db = openDb(":memory:");
  insertMetrics(db, rows);
  expect((db.query("SELECT COUNT(*) c FROM metrics").get() as { c: number }).c).toBe(3);
});

test("parseOtlpMetrics tolerates garbage", () => {
  expect(parseOtlpMetrics(null)).toEqual([]);
  expect(parseOtlpMetrics({ resourceMetrics: "nope" })).toEqual([]);
  expect(parseOtlpMetrics({})).toEqual([]);
});

// Behind the proxy Claude Code reports cost.usage from ITS OWN price list for a model that is
// not in it — the number is made up and the real cost is zero anyway (paid by subscription).
test("cost from a foreign model is not counted, cost from Claude is", () => {
  expect(costIsMeaningful("claude_code.cost.usage", { model: "claude-opus-4-5" })).toBe(true);
  expect(costIsMeaningful("claude_code.cost.usage", { model: "opus" })).toBe(true);
  expect(costIsMeaningful("claude_code.cost.usage", { model: "gpt-5.6-sol" })).toBe(false);
  expect(costIsMeaningful("claude_code.cost.usage", { model: "grok-4.5" })).toBe(false);
});

test("points without a model and other metrics pass through unchanged", () => {
  expect(costIsMeaningful("claude_code.cost.usage", {})).toBe(true);
  expect(costIsMeaningful("claude_code.token.usage", { model: "grok-4.5" })).toBe(true);
});

test("pointsToRows drops only the foreign cost, keeps the tokens", () => {
  const rows = pointsToRows([
    { ts: 1, name: "claude_code.cost.usage",  value: 3, attributes: { model: "grok-4.5" } },
    { ts: 1, name: "claude_code.token.usage", value: 9, attributes: { model: "grok-4.5" } },
  ] as never);
  expect(rows).toHaveLength(1);
  expect(rows[0].name).toBe("claude_code.token.usage");
});

// Dropping a cost is irreversible. If CLAUDE_MODEL_RE did not match a new Claude model, its
// cost would simply vanish from Stats without leaving a trace anywhere — that is exactly
// why this warning exists.
function captureWarn(fn: () => void): string[] {
  const seen: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => { seen.push(a.join(" ")); };
  try { fn(); } finally { console.warn = orig; }
  return seen;
}

// gpt-5.6-sol has a price list since Task 2 — its dropped cc cost is now silent, because a
// synthetic cost.usage fully replaces it (see the test below "foreign cc cost…").
// The drop warning therefore remains only for a model WITHOUT a price list.
test("a dropped cost is reported — once per model, not on every export", () => {
  const warns = captureWarn(() => {
    pointsToRows([{ ts: 1, name: "claude_code.cost.usage", value: 3, attributes: { model: "new-model-x" } }] as never);
    pointsToRows([{ ts: 2, name: "claude_code.cost.usage", value: 4, attributes: { model: "new-model-x" } }] as never);
  });
  expect(warns).toHaveLength(1);
  expect(warns[0]).toContain("new-model-x");
  expect(warns[0]).toContain("CLAUDE_MODEL_RE");
});

// New behaviour from Task 3: a foreign model IN THE PRICE LIST also drops the cc cost (it is still
// a made-up number from cc's foreign price list), but silently — the synthetic one replaces it.
test("a dropped cost of a model IN THE PRICE LIST is not reported — the synthetic one replaces it silently", () => {
  const warns = captureWarn(() => {
    pointsToRows([{ ts: 1, name: "claude_code.cost.usage", value: 3, attributes: { model: "gpt-5.6-sol" } }] as never);
  });
  expect(warns).toHaveLength(0);
});

// `<synthetic>` is the model Claude Code uses to mark locally produced messages (error
// message, interruption). Verified in the claude 2.1.237 binary: such messages have
// `model:"<synthetic>"` and zero usage, so their cost is 0 — dropping them is
// correct. Reporting them is not: it would be a permanent warning about something fine that
// would drown the one that matters.
test("<synthetic> is dropped without a warning — it is a normal state, not a bad regex", () => {
  resetCostWarnings();
  let rows: unknown[] = [];
  const warns = captureWarn(() => {
    rows = pointsToRows([{ ts: 1, name: "claude_code.cost.usage", value: 0, attributes: { model: "<synthetic>" } }] as never);
  });
  expect(rows).toHaveLength(0);
  expect(warns).toHaveLength(0);
});

// Task 3: synthetic cost from the price list (pricing.ts) for token.usage of foreign models —
// the only place where OTLP ingestion produces a cost for a foreign model, because cc cannot
// compute it (see costIsMeaningful above).
const point = (name: string, value: number, attrs: Record<string, string | number>): DataPoint =>
  ({ name, value, timeUnixNano: 1_700_000_000_000_000_000, attributes: attrs });

test("token.usage of a foreign model produces a synthetic cost.usage from the price list", () => {
  const rows = pointsToRows([
    point("claude_code.token.usage", 1_000_000, { model: "grok-4.6", type: "input", "devbox.session.id": "dev-a-b" }),
  ]);
  const cost = rows.filter((r) => r.name === "claude_code.cost.usage");
  expect(cost).toHaveLength(1);
  expect(cost[0].value).toBeCloseTo(2);
  expect(cost[0].session_id).toBe("dev-a-b");
  expect(JSON.parse(cost[0].attrs).model).toBe("grok-4.6");
});

test("type cacheCreation is priced as cacheWrite, cacheRead as cached input", () => {
  const rows = pointsToRows([
    point("claude_code.token.usage", 1_000_000, { model: "gpt-5.6-sol", type: "cacheRead" }),
    point("claude_code.token.usage", 1_000_000, { model: "gpt-5.6-sol", type: "cacheCreation" }),
  ]);
  const vals = rows.filter((r) => r.name === "claude_code.cost.usage").map((r) => r.value);
  expect(vals[0]).toBeCloseTo(0.4);
  expect(vals[1]).toBeCloseTo(5);
});

test("Claude models unchanged: no synthetic row, cc cost is taken over", () => {
  const rows = pointsToRows([
    point("claude_code.token.usage", 500, { model: "claude-opus-5", type: "input" }),
    point("claude_code.cost.usage", 0.123, { model: "claude-opus-5" }),
  ]);
  expect(rows.filter((r) => r.name === "claude_code.cost.usage")).toHaveLength(1);
  expect(rows.find((r) => r.name === "claude_code.cost.usage")!.value).toBeCloseTo(0.123);
});

test("foreign cc cost is still dropped — even when the model is in the price list (the synthetic one replaces it)", () => {
  const rows = pointsToRows([point("claude_code.cost.usage", 99, { model: "grok-4.6" })]);
  expect(rows).toHaveLength(0);
});

test("model without a price list: tokens yes, cost no", () => {
  const rows = pointsToRows([point("claude_code.token.usage", 1000, { model: "new-model-x", type: "input" })]);
  expect(rows.filter((r) => r.name === "claude_code.token.usage")).toHaveLength(1);
  expect(rows.filter((r) => r.name === "claude_code.cost.usage")).toHaveLength(0);
});

test("retired stealth slug retains tokens without inventing a current zero price", () => {
  let rows: unknown[] = [];
  const warns = captureWarn(() => {
    rows = pointsToRows([point("claude_code.token.usage", 1_000_000, { model: "stealth/ox-alpha", type: "input" })]);
  });
  expect((rows as { name: string }[]).filter((r) => r.name === "claude_code.token.usage")).toHaveLength(1);
  expect((rows as { name: string }[]).filter((r) => r.name === "claude_code.cost.usage")).toHaveLength(0);
  expect(warns).toHaveLength(1);
});
