import { expect, test } from "bun:test";
import { join } from "node:path";
import { readFileSync } from "node:fs";

test("image/tmux.conf: terminal title = manual label, otherwise the Claude title", () => {
  const conf = readFileSync(join(import.meta.dir, "..", "..", "image", "tmux.conf"), "utf8");
  expect(conf).toContain("set -g set-titles on");
  expect(conf).toContain('set -g set-titles-string "#{?@devd_label,#{@devd_label},#{?@devd_session_name,#{@devd_session_name},#{?@devd_auto_title,#{@devd_auto_title},#{pane_title}}}}"');
});
