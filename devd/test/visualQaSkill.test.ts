import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SKILL = join(import.meta.dir, "..", "..", "tools", "skills", "visual-qa", "SKILL.md");

test("visual-qa SKILL.md has frontmatter, triggers and a browser QA guide", () => {
  const t = readFileSync(SKILL, "utf8");
  expect(t.startsWith("---")).toBe(true);
  expect(t).toMatch(/^name:\s*visual-qa/m);
  expect(t).toMatch(/^description:\s*.+/m);
  expect(t.toLowerCase()).toContain("visual qa");
  expect(t).toContain("localhost");                     // QA against a server running in the container
  expect(t).toContain("browser_snapshot");              // cheap a11y tree first
  expect(t).toContain("browser_take_screenshot");       // visuals as an image
  expect(t.toLowerCase()).toContain("mac-preview");     // distinct from preview for a human
});
