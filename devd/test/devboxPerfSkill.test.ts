import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SKILL = join(import.meta.dir, "..", "..", "tools", "skills", "devbox-perf", "SKILL.md");
const text = () => readFileSync(SKILL, "utf8");

test("devbox-perf SKILL.md has frontmatter and triggers for slow loading", () => {
  const t = text();
  expect(t.startsWith("---")).toBe(true);
  expect(t).toMatch(/^name:\s*devbox-perf/m);
  expect(t).toMatch(/^description:\s*.+/m);
  // By the phrases a user describes the problem with, not by the technique's name.
  expect(t).toContain("it loads slowly");
  expect(t).toContain("make it faster");
});

test("the skill leads to measurement that detects a dead server", () => {
  const t = text();
  // This is the trap that in practice produced a fake thousandfold speedup:
  // curl on an unreachable port returns 0 B and looks lightning fast.
  expect(t).toContain("%{http_code}");
  expect(t).toContain("%{size_download}");
});

test("the skill carries verified facts about the architecture so they are not measured again", () => {
  const t = text();
  expect(t).toContain("single JS thread");      // blocking synchronous SQLite
  expect(t).toContain("VIRTUAL");                // a generated column does NOT work as a covering one
  expect(t).toContain("name IN");                // merging metrics is slower
});

test("the skill warns about browser measurement traps", () => {
  const t = text();
  expect(t).toContain("networkidle");            // hangs because of the 5s poll
  expect(t).toContain("launchPersistentContext"); // otherwise you cannot measure the browser cache
  expect(t.toLowerCase()).toContain("median");    // a single measurement lies
});

test("the skill reminds that a devd restart locks the vault", () => {
  const t = text();
  expect(t.toLowerCase()).toContain("locks the vault");
  expect(t).toContain("devd restart");
});
