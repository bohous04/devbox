import { expect, test } from "bun:test";
import { EffortState } from "../src/effort";
import type { BridgeEvent } from "../src/events";

function tracked(chosen: string | null = null) {
  const events: BridgeEvent[] = [];
  return { events, effort: new EffortState((e) => events.push(e), chosen) };
}

test("effort.state goes out only when something changed", () => {
  const { events, effort } = tracked();
  effort.update({ model: "m1", supported: ["low", "high"], effective: "high" });
  effort.update({ model: "m1", supported: ["low", "high"], effective: "high" });
  expect(events).toEqual([{ type: "effort.state", model: "m1", supported: ["low", "high"], effective: "high", chosen: null }]);
});

test("a choice the model does not offer is dropped with a notice; the effective level follows the remaining choice", () => {
  const { events, effort } = tracked("max");
  expect(effort.update({ model: "m1", supported: ["low", "high"], effective: (c) => c ?? "high" })).toBe(true);
  expect(effort.chosen).toBeNull();
  expect(events).toEqual([
    { type: "bridge.notice", text: "Effort max is not available on m1; back to its default." },
    { type: "effort.state", model: "m1", supported: ["low", "high"], effective: "high", chosen: null },
  ]);
});

test("check refuses a level before the levels are known, one the model lacks, and any level on a model without levels", () => {
  const { effort } = tracked();
  expect(() => effort.check("high")).toThrow("not reported its effort levels yet");
  effort.check(null);
  effort.update({ model: "m1", supported: ["low"] });
  expect(() => effort.check("high")).toThrow("effort high is not one of low");
  effort.update({ model: "acp", supported: [] });
  expect(() => effort.check("low")).toThrow("acp has no effort levels");
});
