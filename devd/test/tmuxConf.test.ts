import { expect, test } from "bun:test";
import { join } from "node:path";
import { readFileSync } from "node:fs";

test("image/tmux.conf: terminal title = manual label, otherwise the Claude title", () => {
  const conf = readFileSync(join(import.meta.dir, "..", "..", "image", "tmux.conf"), "utf8");
  expect(conf).toContain("set -g set-titles on");
  expect(conf).toContain('set -g set-titles-string "#{?@devd_label,#{@devd_label},#{?@devd_session_name,#{@devd_session_name},#{?@devd_auto_title,#{@devd_auto_title},#{pane_title}}}}"');
});

const TMUX_CONF = join(import.meta.dir, "..", "..", "image", "tmux.conf");
const hasTmux = Bun.spawnSync(["sh", "-c", "command -v tmux"]).exitCode === 0;

test("image/tmux.conf: OSC 52 from apps in the pane is accepted (browser / local-terminal copy)", () => {
  expect(readFileSync(TMUX_CONF, "utf8")).toMatch(/^set -g set-clipboard on$/m);
});

test.skipIf(!hasTmux)("tmux with image/tmux.conf: an app's OSC 52 lands in the tmux buffer (forwarded to clients)", async () => {
  const sock = `devbox-osc52-${process.pid}-${Date.now()}`;
  const t = (...a: string[]) => Bun.spawnSync(["tmux", "-L", sock, "-f", TMUX_CONF, ...a], { stdout: "pipe", stderr: "pipe" });
  try {
    expect(t("new-session", "-d", "-x", "80", "-y", "24", "sh").exitCode).toBe(0);
    // "hi from the pane" in base64; BEL-terminated like Claude Code / most apps send it
    t("send-keys", "-t", "0", "printf '\\033]52;c;aGkgZnJvbSB0aGUgcGFuZQ==\\007'", "Enter");
    let buf = "";
    for (let i = 0; i < 20 && buf !== "hi from the pane"; i++) {
      await Bun.sleep(100);
      buf = new TextDecoder().decode(t("show-buffer").stdout);
    }
    expect(buf).toBe("hi from the pane");
  } finally {
    t("kill-server");
  }
});
