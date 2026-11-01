import { expect, test } from "bun:test";
import {
  altCfg, buildExecArgv, capturePaneArgv, EXIT_KEY, labelSetCmd,
  probeArgv, rememberDockerHosts, sessionTitleCommand, sessionPickerOptions, singleQuote, tmuxCommand,
} from "../src/attach";
import { probeCmd } from "../../devd/src/tmux";

// Shortened TmuxSession literal for sessionPickerOptions tests, which only care about
// name + agent (+ attached). `as never`: `title` is deliberately missing.
const s = (name: string, agent?: string, attached = 0) =>
  ({ name, agent: agent ?? null, attached, label: null }) as never;

const IDENTITY =
  'tmux set -g status-left-length 40 2>/dev/null; '
  + 'tmux set -g set-titles on 2>/dev/null; '
  + 'tmux set -g @devd_session_name "$DEVD_SESSION_NAME" 2>/dev/null; '
  + 'tmux set -g set-titles-string "#{?@devd_label,#{@devd_label},#{?@devd_session_name,#{@devd_session_name},#{?@devd_auto_title,#{@devd_auto_title},#{pane_title}}}}" 2>/dev/null; '
  + '[ -n "$DEVD_PROJECT" ] && tmux set -g status-left " $DEVD_PROJECT/${DEVD_REPO:-} | " 2>/dev/null';

// Fallback shim: an old image has no agent-launch, only claude-launch (see launchCmd).
const LAUNCH =
  `sh -lc 'if [ -x /usr/local/bin/agent-launch ]; then exec /usr/local/bin/agent-launch; else exec /usr/local/bin/claude-launch; fi'`;

test("tmuxCommand: create-detached → identity → attach, on main and on a named session", () => {
  expect(tmuxCommand()).toBe(
    `tmux has-session -t =main 2>/dev/null || tmux new-session -d -s main -c /workspace ${LAUNCH}; ` +
    IDENTITY + "; " + sessionTitleCommand("main") + "; " + EXIT_KEY + "; tmux attach -d -t =main");
  expect(tmuxCommand("main-2")).toBe(
    `tmux has-session -t =main-2 2>/dev/null || tmux new-session -d -s main-2 -c /workspace ${LAUNCH}; ` +
    IDENTITY + "; " + sessionTitleCommand("main-2") + "; " + EXIT_KEY + "; tmux attach -d -t =main-2");
});

// REGRESSION "F9 needs two presses": on an existing session `new-session -A` behaves like
// attach-session (ignores `-d`) — the terminal was attached by the chain's first command,
// the 1st F9 press detached THAT one (code 42 got lost in the middle of `;`) and the final
// attach reattached the terminal right away. So only the chain's last command may attach:
// no `-A` and exactly one `tmux attach`, at the end.
test("tmuxCommand: nothing that can attach may come before the final attach", () => {
  for (const cmd of [tmuxCommand(), tmuxCommand("main-2")]) {
    expect(cmd).not.toContain("new-session -A");
    expect(cmd).toContain("has-session");
    const parts = cmd.split("; ");
    expect(parts.filter((p) => p.startsWith("tmux attach"))).toHaveLength(1);
    expect(parts[parts.length - 1]).toStartWith("tmux attach");
  }
});

// `=` forces an exact name match: without it, with a dead `main` and a live `main-2`, both
// the guard and the attach would silently match `main-2` by prefix instead of creating `main`.
test("tmuxCommand targets the session by exact name (=), not by prefix", () => {
  expect(tmuxCommand()).toContain("has-session -t =main ");
  expect(tmuxCommand()).toContain("tmux attach -d -t =main");
  expect(tmuxCommand("main-2")).toContain("has-session -t =main-2 ");
});

// `-d` prevents orphaned attach processes from piling up (dropped ssh, closed Warp tab —
// `docker exec … tmux attach` survives inside and lingers as a client; five measured at once).
test("tmuxCommand attaches with -d so orphaned clients do not pile up", () => {
  for (const cmd of [tmuxCommand(), tmuxCommand("main-2")]) {
    expect(cmd).toContain("tmux attach -d -t");
  }
});

// Only one mode is left (mirroring): the `main-N` allocator and passing a profile to the
// launcher went away with sub-session creation, so they must not sneak back in.
test("tmuxCommand creates no extra main-N and forces no profile — the launcher uses the container default", () => {
  for (const cmd of [tmuxCommand(), tmuxCommand("main-2")]) {
    expect(cmd).not.toContain("has-session -t main-$n");
    expect(cmd).toContain("exec /usr/local/bin/agent-launch;");   // no profile argument
  }
});

test("launchCmd falls back to claude-launch on an old container (no agent-launch)", () => {
  for (const cmd of [tmuxCommand(), tmuxCommand("main-2")]) {
    expect(cmd).toContain("if [ -x /usr/local/bin/agent-launch ]");
    expect(cmd).toContain("else exec /usr/local/bin/claude-launch; fi");
  }
});

test("tmuxCommand always binds F9 to exit (detach-client -E exit 42)", () => {
  for (const cmd of [tmuxCommand(), tmuxCommand("main-2")]) {
    expect(cmd).toContain('tmux bind-key -n F9 detach-client -E "exit 42"');
  }
});

test("tmuxCommand always fills in identity (status-left + length from DEVD_PROJECT), guarded", () => {
  for (const cmd of [tmuxCommand(), tmuxCommand("main-2")]) {
    expect(cmd).toContain("tmux set -g status-left-length 40"); // otherwise ` project/repo | ` gets truncated (default 10)
    expect(cmd).toContain('[ -n "$DEVD_PROJECT" ]');
    expect(cmd).toContain('tmux set -g status-left " $DEVD_PROJECT/${DEVD_REPO:-} | "');
  }
});

test("tmuxCommand self-heals set-titles-string even on running containers (old conf baked into image)", () => {
  for (const cmd of [tmuxCommand(), tmuxCommand("main-2")]) {
    expect(cmd).toContain('tmux set -g set-titles-string "#{?@devd_label,#{@devd_label},#{?@devd_session_name,#{@devd_session_name},#{?@devd_auto_title,#{@devd_auto_title},#{pane_title}}}}"');
  }
});

test("probeArgv: a single non-interactive tmux call (replaces list-sessions + list-clients)", () => {
  expect(probeArgv({ devdUrl: "u" }, "c")).toEqual(["docker", "exec", "c", "bash", "-lc", probeCmd()]);
  const remote = probeArgv({ devdUrl: "u", sshHost: "vps" }, "c");
  expect(remote[0]).toBe("ssh");
  expect(remote).not.toContain("-t");
});

test("sessionPickerOptions: agent and label on existing sessions", () => {
  const opts = sessionPickerOptions([
    { name: "main", label: null, agent: "claude", title: null, attached: 0 },
    { name: "main-2", label: "refactor", agent: "codex", title: null, attached: 0 },
  ]);
  expect(opts[0].label).toContain("main");
  expect(opts[1].label).toContain("Codex");
  expect(opts[1].label).toContain("refactor");
});

test("attach picker no longer offers creating another window", () => {
  const opts = sessionPickerOptions([s("main", "claude"), s("main-2", "codex")]);
  // Attaching to existing windows still works — the container may have them from before;
  // only the item that created a new one is gone (another session = its own container).
  expect(opts.map((o) => o.value)).toEqual(["main", "main-2"]);
});

test("labelSetCmd: set, clear (-u), and apostrophe escaping", () => {
  expect(labelSetCmd("main-2", "SHOP-58")).toBe("tmux set -t main-2 @devd_label 'SHOP-58' 2>/dev/null");
  expect(labelSetCmd("main", null)).toBe("tmux set -u -t main @devd_label 2>/dev/null");
  expect(labelSetCmd("main", "a'b")).toContain(`'a'\\''b'`);
});

test("capturePaneArgv takes a session name (default main)", () => {
  expect(capturePaneArgv({ devdUrl: "u" }, "c")).toEqual([
    "docker", "exec", "c", "bash", "-lc", "tmux capture-pane -p -t main -S -40 2>/dev/null"]);
  expect(capturePaneArgv({ devdUrl: "u" }, "c", "main-2")[5])
    .toBe("tmux capture-pane -p -t main-2 -S -40 2>/dev/null");
});

test("singleQuote survives embedded quotes", () => {
  expect(singleQuote("a'b")).toBe("'a'\\''b'");
});

test("local exec argv", () => {
  expect(buildExecArgv({ devdUrl: "u" }, "dev-shop-cms", "tmux attach -t main"))
    .toEqual(["docker", "exec", "-it", "dev-shop-cms", "bash", "-lc", "tmux attach -t main"]);
});

test("ssh exec argv quotes the remote command", () => {
  const argv = buildExecArgv({ devdUrl: "u", sshHost: "vps" }, "dev-shop-cms", "tmux attach -t main");
  expect(argv[0]).toBe("ssh");
  expect(argv).toContain("-t");
  expect(argv[argv.length - 2]).toBe("vps");
  expect(argv[argv.length - 1]).toBe("docker exec -it dev-shop-cms bash -lc 'tmux attach -t main'");
});

test("ssh argv carries keepalive options (a drop is noticed within ~15s, reconnect doesn't hang)", () => {
  const argv = buildExecArgv({ devdUrl: "u", sshHost: "vps" }, "c", "true").join(" ");
  expect(argv).toContain("-o ServerAliveInterval=5");
  expect(argv).toContain("-o ServerAliveCountMax=3");
  expect(argv).toContain("-o ConnectTimeout=10");
});

test("altCfg: backup path = same config with sshHost swapped for sshHostAlt", () => {
  expect(altCfg({ devdUrl: "u", sshHost: "vps", sshHostAlt: "vps-ts" }))
    .toEqual({ devdUrl: "u", sshHost: "vps-ts", sshHostAlt: "vps-ts" });
  expect(altCfg({ devdUrl: "u", sshHost: "vps" })).toBeUndefined();
  expect(altCfg({ devdUrl: "u" })).toBeUndefined(); // local docker mode
});

test("altCfg + buildExecArgv: same remote command, different ssh host", () => {
  const cfg = { devdUrl: "u", sshHost: "vps", sshHostAlt: "vps-ts" };
  const primary = buildExecArgv(cfg, "c", "true");
  const alt = buildExecArgv(altCfg(cfg)!, "c", "true");
  expect(primary[primary.length - 2]).toBe("vps");
  expect(alt[alt.length - 2]).toBe("vps-ts");
  expect(alt[alt.length - 1]).toBe(primary[primary.length - 1]);
});

test("local docker branch has NO keepalive options", () => {
  const argv = buildExecArgv({ devdUrl: "u" }, "c", "true").join(" ");
  expect(argv).not.toContain("ServerAliveInterval");
});

test("buildExecArgv: remote docker for an instabox session, only via sshHost", () => {
  rememberDockerHosts([{ container: "dev-p-r", dockerHost: "ibx-m_1" }]);
  try {
    expect(buildExecArgv({ devdUrl: "u", sshHost: "vps" }, "dev-p-r", "tmux a", true).at(-1))
      .toBe("docker -H ssh://ibx-m_1 exec -it dev-p-r bash -lc 'tmux a'");
    expect(() => buildExecArgv({ devdUrl: "u" }, "dev-p-r", "tmux a")).toThrow("sshHost");
  } finally {
    rememberDockerHosts([{ container: "dev-p-r", dockerHost: null }]);
  }
  expect(buildExecArgv({ devdUrl: "u", sshHost: "vps" }, "dev-p-r", "tmux a", true).at(-1)).toBe("docker exec -it dev-p-r bash -lc 'tmux a'");
});

test("capturePane argv is non-interactive plain-text tmux capture", () => {
  const local = capturePaneArgv({ devdUrl: "u" }, "c");
  expect(local).toEqual(["docker", "exec", "c", "bash", "-lc", "tmux capture-pane -p -t main -S -40 2>/dev/null"]);
  const remote = capturePaneArgv({ devdUrl: "u", sshHost: "vps" }, "c");
  expect(remote[0]).toBe("ssh");
  expect(remote).not.toContain("-t");
});
