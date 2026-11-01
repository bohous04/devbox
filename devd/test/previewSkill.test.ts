import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SKILL = join(import.meta.dir, "..", "..", "tools", "skills", "mac-preview", "SKILL.md");

test("mac-preview SKILL.md has frontmatter, triggers and the preview command", () => {
  const t = readFileSync(SKILL, "utf8");
  expect(t.startsWith("---")).toBe(true);
  expect(t).toMatch(/^name:\s*mac-preview/m);
  expect(t).toMatch(/^description:\s*.+/m);
  expect(t.toLowerCase()).toContain("show it on the mac");
  expect(t).toContain("`preview");                  // mentions the command
  expect(t).toContain("DEVD_SESSION_ID");            // guardrail
});
