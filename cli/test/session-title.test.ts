import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { singleQuote, tmuxCommand, withSessionName } from "../src/attach";

test("session name survives shell quoting and strips terminal control characters", () => {
  const name = "O'Brien: $(exit 9) `exit 8` # {café session}";
  const result = Bun.spawnSync(["bash", "-c", withSessionName('printf %s "$DEVD_SESSION_NAME"', name)]);
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toBe(name);
  expect(withSessionName("true", "\x1bA\x07\n")).toContain("'A'");
});

test.skipIf(!Bun.which("tmux"))("resuming applies nickname, preserves tmux label, and clears a removed nickname", () => {
  const dir = mkdtempSync(join(tmpdir(), "devbox-title-"));
  const socket = join(dir, "tmux.sock");
  // `-u`: without a UTF-8 locale (bare LANG on Linux) tmux would rewrite non-ASCII characters to `_`.
  const tmux = (...args: string[]) => Bun.spawnSync(["tmux", "-u", "-S", socket, ...args]);
  try {
    expect(tmux("-f", "/dev/null", "new-session", "-d", "-s", "main", "sleep 60").exitCode).toBe(0);
    tmux("select-pane", "-t", "main", "-T", "Live agent title");
    tmux("set-option", "-t", "main", "set-titles-string", "Old hook override");
    const command = tmuxCommand();
    // Execute the real resume setup; only the interactive attach is replaced.
    const setup = command.slice(0, command.lastIndexOf("; tmux attach"));
    const resume = (name: string | null) => {
      const result = Bun.spawnSync(["bash", "-c",
        `tmux() { command tmux -u -S ${singleQuote(socket)} "$@"; }; ` + withSessionName(setup, name)],
        { env: { ...process.env, DEVD_PROJECT: "test", DEVD_REPO: "repo" } });
      expect(result.exitCode).toBe(0);
    };
    const title = () => {
      const format = tmux("show-options", "-v", "-t", "main", "set-titles-string").stdout.toString().trim();
      return tmux("display-message", "-p", "-t", "main", format).stdout.toString().trim();
    };
    const name = "O'Brien: fix $(exit 9) #{pane_title}";
    resume(name);
    expect(title()).toBe(name);
    expect(tmux("show-options", "-gv", "set-titles").stdout.toString().trim()).toBe("on");
    tmux("set-option", "-t", "main", "@devd_label", "Café tmux label");
    resume("Naïve new name");
    expect(title()).toBe("Café tmux label");
    tmux("set-option", "-u", "-t", "main", "@devd_label");
    expect(title()).toBe("Naïve new name");
    resume(null);
    expect(title()).toBe("Live agent title");
  } finally {
    tmux("kill-server");
    rmSync(dir, { recursive: true, force: true });
  }
});
