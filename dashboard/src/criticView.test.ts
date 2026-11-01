import { expect, test } from "bun:test";
import { criticBadge, findingLines, type CriticReview } from "./criticView";

const review = (over: Partial<CriticReview>): CriticReview => ({
  id: 1, session_id: "dev-shop-cms", turn_id: "t1", round: 1, verdict: "ok",
  findings: "[]", evidence: null, ms: 1200, at: 1000, ...over,
});

test("no review means no badge", () => {
  expect(criticBadge(null)).toBeNull();
});

test("clean verdict = green badge", () => {
  expect(criticBadge(review({ verdict: "ok" }))).toEqual({ text: "Review passed", kind: "ok" });
});

test("findings = warning badge with a count (singular and plural)", () => {
  const one = criticBadge(review({ verdict: "issues", findings: '[{"severity":"critical","what":"x"}]' }));
  expect(one).toEqual({ text: "1 issue", kind: "warn" });
  const three = criticBadge(review({
    verdict: "issues",
    findings: '[{"severity":"critical","what":"a"},{"severity":"important","what":"b"},{"severity":"important","what":"c"}]',
  }));
  expect(three).toEqual({ text: "3 issues", kind: "warn" });
  const four = criticBadge(review({
    verdict: "issues",
    findings: '[{"severity":"critical","what":"a"},{"severity":"important","what":"b"},{"severity":"important","what":"c"},{"severity":"important","what":"d"}]',
  }));
  expect(four).toEqual({ text: "4 issues", kind: "warn" });
  const five = criticBadge(review({
    verdict: "issues",
    findings: '[{"severity":"critical","what":"a"},{"severity":"important","what":"b"},{"severity":"important","what":"c"},{"severity":"important","what":"d"},{"severity":"important","what":"e"}]',
  }));
  expect(five).toEqual({ text: "5 issues", kind: "warn" });
});

test("minor findings don't count toward the total", () => {
  expect(criticBadge(review({ verdict: "issues", findings: '[{"severity":"minor","what":"x"}]' })))
    .toEqual({ text: "Review passed", kind: "ok" });
});

test("critic error = red badge", () => {
  expect(criticBadge(review({ verdict: "error", evidence: "timeout" })))
    .toEqual({ text: "Critic failed", kind: "danger" });
});

test("findings render as file:line — what (why)", () => {
  const lines = findingLines(review({
    verdict: "issues",
    findings: '[{"severity":"critical","file":"a.ts","line":3,"what":"missing await","why":"race"},{"severity":"important","what":"no test"}]',
  }));
  expect(lines[0]).toBe("a.ts:3 — missing await (race)");
  expect(lines[1]).toBe("no test");
});

test("broken findings JSON doesn't crash", () => {
  expect(findingLines(review({ findings: "{this isn't JSON" }))).toEqual([]);
  expect(criticBadge(review({ verdict: "issues", findings: "nonsense" }))).toEqual({ text: "Review passed", kind: "ok" });
});
