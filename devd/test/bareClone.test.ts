import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { barePath, isBareLayout } from "../src/tree";

test("the bare clone path is the repo with a .git suffix", () => {
  expect(barePath("/srv/dev", "acme", "portal", "web")).toBe("/srv/dev/acme/portal/web.git");
  // a flat folder (project === folder) is composed one level up, same as workspacePath
  expect(barePath("/srv/dev", "apps", "apps", "web")).toBe("/srv/dev/apps/web.git");
});

// It MUST be detected from the disk, not from the presence of a session: existing repos
// stay in the old layout and the code must handle both without guessing.
test("the old layout is recognised by the bare clone not existing", () => {
  const root = mkdtempSync(join(tmpdir(), "layout-"));
  expect(isBareLayout(root, "acme", "portal", "web")).toBe(false);
});

test("the new layout is recognised by the bare clone existing", () => {
  const root = mkdtempSync(join(tmpdir(), "layout-"));
  mkdirSync(barePath(root, "acme", "portal", "web"), { recursive: true });
  expect(isBareLayout(root, "acme", "portal", "web")).toBe(true);
});
