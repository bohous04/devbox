import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installQuickAction, renderPlist } from "../install.ts"; // explicit extension — a sibling `install/` directory exists

test("renderPlist fills placeholders and keeps label", () => {
  const tpl = readFileSync(join(import.meta.dir, "..", "install", "cz.devbox.listener.plist"), "utf8");
  const out = renderPlist(tpl, "/opt/homebrew/bin/bun", "/Users/x/repo");
  expect(out).toContain("<string>/opt/homebrew/bin/bun</string>");
  expect(out).toContain("<string>/Users/x/repo/listener/src/main.ts</string>");
  expect(out).toContain("<string>cz.devbox.listener</string>");
  expect(out).not.toContain("__BUN__");
  expect(out).not.toContain("__REPO__");
});

test("install copies SendToDevbox.workflow to ~/Library/Services", () => {
  const home = mkdtempSync(join(tmpdir(), "home-"));
  installQuickAction(home, join(import.meta.dir, "..", "install")); // new exported function
  expect(existsSync(join(home, "Library", "Services", "SendToDevbox.workflow", "Contents", "document.wflow"))).toBe(true);
});
