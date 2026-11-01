import { expect, test } from "bun:test";
import { join } from "node:path";
import { readFileSync } from "node:fs";

const dockerfile = readFileSync(join(import.meta.dir, "..", "..", "image", "Dockerfile"), "utf8");

test("cc is installed in its own layer with ARG CC_VERSION", () => {
  expect(dockerfile).toContain("ARG CC_VERSION=latest");
  expect(dockerfile).toContain("npm install -g @anthropic-ai/claude-code@${CC_VERSION}");
});

test("the cc layer comes AFTER the Playwright chromium install (a version bump must not invalidate chromium)", () => {
  const playwright = dockerfile.indexOf("install --with-deps chromium");
  const cc = dockerfile.indexOf("@anthropic-ai/claude-code@${CC_VERSION}");
  expect(playwright).toBeGreaterThan(-1);
  expect(cc).toBeGreaterThan(playwright);
});

test("the original shared layer no longer installs cc", () => {
  const line = dockerfile.split("\n").find((l) => l.includes("npm install -g pnpm"));
  expect(line).toBeDefined();
  expect(line).not.toContain("claude-code");
});
