import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Runs image/agent-bridge-launch.sh with a stub `agent-bridge` (scripted exit codes and run lengths) and a stub
// `sleep` that only records the restart delays.
const LAUNCHER = join(import.meta.dir, "..", "..", "agent-bridge-launch.sh");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "launcher-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Each run: `[exitCode, seconds it stays up]`. */
function launch(runs: [number, number][]) {
  writeFileSync(join(dir, "runs"), runs.map(([code, secs]) => `${code} ${secs}`).join("\n") + "\n");
  writeFileSync(
    join(dir, "agent-bridge"),
    `#!/usr/bin/env bash
n=$(( $(cat "${dir}/count" 2>/dev/null || echo 0) + 1 )); echo "$n" > "${dir}/count"
read -r code secs < <(sed -n "\${n}p" "${dir}/runs")
[ -n "\${code:-}" ] || { echo "stub: no run $n scripted" >&2; exit 99; }
[ "$secs" = 0 ] || /bin/sleep "$secs"
exit "$code"
`,
  );
  writeFileSync(join(dir, "sleep"), `#!/usr/bin/env bash\necho "$1" >> "${dir}/delays"\n`);
  chmodSync(join(dir, "agent-bridge"), 0o755);
  chmodSync(join(dir, "sleep"), 0o755);
  const p = Bun.spawnSync(["bash", LAUNCHER], {
    env: {
      PATH: `${dir}:/usr/bin:/bin`,
      DEVD_AGENT: "claude",
      CLAUDE_CONFIG_DIR: "/home/dev/.claude",
      // Instant stub runs take 0–1 s; a "long" run stays up 3 s.
      DEVBOX_BRIDGE_QUICK_SECS: "2",
      DEVBOX_BRIDGE_MAX_FAILS: "5",
    },
    stderr: "pipe",
  });
  const read = (f: string) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8").trim() : "");
  return {
    status: p.exitCode,
    stderr: p.stderr.toString(),
    runs: Number(read("count")),
    delays: read("delays") ? read("delays").split("\n").map(Number) : [],
  };
}

test("stops on 0 (stop command)", () => {
  const r = launch([[1, 0], [0, 0]]);
  expect(r).toMatchObject({ status: 0, runs: 2, delays: [2] });
});

test("stops on 3 (configuration error) with one log line", () => {
  const r = launch([[3, 0]]);
  expect(r).toMatchObject({ status: 3, runs: 1, delays: [] });
  expect(r.stderr).toContain("configuration error");
});

test("gives up after N quick failures, doubling the delay", () => {
  const r = launch([[1, 0], [1, 0], [1, 0], [1, 0], [1, 0], [0, 0]]);
  expect(r).toMatchObject({ status: 1, runs: 5, delays: [2, 4, 8, 16] });
  expect(r.stderr).toContain("agent-bridge failed 5 times in a row; giving up — the session shows as disconnected");
});

test("a long run resets the failure counter and the delay", () => {
  const r = launch([[1, 0], [1, 0], [1, 0], [1, 3], [1, 0], [1, 0], [0, 0]]);
  expect(r).toMatchObject({ status: 0, runs: 7, delays: [2, 4, 8, 2, 2, 4] });
}, 15_000);

test("a proxy profile starts serve on the image's claude home (serve translates the profile env)", () => {
  writeFileSync(join(dir, "agent-bridge"), `#!/usr/bin/env bash\necho "$DEVD_AGENT|$CLAUDE_CONFIG_DIR" > "${dir}/env"\nexit 0\n`);
  chmodSync(join(dir, "agent-bridge"), 0o755);
  const p = Bun.spawnSync(["bash", LAUNCHER], {
    env: { PATH: `${dir}:/usr/bin:/bin`, DEVD_AGENT: "claude-gemini", CLAUDE_CONFIG_DIR: "/home/dev/.claude" },
    stderr: "pipe",
  });
  expect(p.stderr.toString()).toBe("");
  expect(p.exitCode).toBe(0);
  expect(readFileSync(join(dir, "env"), "utf8").trim()).toBe("claude-gemini|/home/dev/.claude");
});

test("an ACP agent starts serve with nothing to prepare (its login is in its own volume)", () => {
  writeFileSync(join(dir, "agent-bridge"), `#!/usr/bin/env bash\necho "$DEVD_AGENT|\${CLAUDE_CONFIG_DIR:-}|\${CODEX_HOME:-}" > "${dir}/env"\nexit 0\n`);
  chmodSync(join(dir, "agent-bridge"), 0o755);
  for (const agent of ["grok", "antigravity", "vibe", "opencode"]) {
    const p = Bun.spawnSync(["bash", LAUNCHER], { env: { PATH: `${dir}:/usr/bin:/bin`, DEVD_AGENT: agent }, stderr: "pipe" });
    expect(p.stderr.toString()).toBe("");
    expect(p.exitCode).toBe(0);
    expect(readFileSync(join(dir, "env"), "utf8").trim()).toBe(`${agent}||`);
  }
});

// An old session row can still name a profile that was removed; the launcher refuses it instead of guessing.
test("an unknown profile is refused with exit 2 and serve never starts", () => {
  writeFileSync(join(dir, "agent-bridge"), `#!/usr/bin/env bash\ntouch "${dir}/ran"\n`);
  chmodSync(join(dir, "agent-bridge"), 0o755);
  const p = Bun.spawnSync(["bash", LAUNCHER], {
    env: { PATH: `${dir}:/usr/bin:/bin`, DEVD_AGENT: "claude-removed", CLAUDE_CONFIG_DIR: "/home/dev/.claude" },
    stderr: "pipe",
  });
  expect(p.exitCode).toBe(2);
  expect(p.stderr.toString()).toContain('unknown DEVD_AGENT "claude-removed"');
  expect(existsSync(join(dir, "ran"))).toBe(false);
});

test("codex chat runs on the shadow home reported by `agent-bridge codex-home`", () => {
  writeFileSync(
    join(dir, "agent-bridge"),
    `#!/usr/bin/env bash
if [ "$1" = codex-home ]; then echo "/shadow/$2"; exit 0; fi
echo "$CODEX_HOME|$CODEX_SQLITE_HOME|$DEVD_CODEX_ACCOUNT_ID|$DEVD_CODEX_REMOTE" > "${dir}/env"
exit 0
`,
  );
  chmodSync(join(dir, "agent-bridge"), 0o755);
  const p = Bun.spawnSync(["bash", LAUNCHER], {
    env: { PATH: `${dir}:/usr/bin:/bin`, DEVD_AGENT: "codex", CODEX_HOME: "/home/dev/.codex", DEVD_CODEX_ACCOUNTS_DIR: dir },
    stderr: "pipe",
  });
  expect(p.stderr.toString()).toBe("");
  expect(p.exitCode).toBe(0);
  expect(readFileSync(join(dir, "env"), "utf8").trim()).toBe("/shadow/default|/shadow/default/sqlite|default|");
});

test.skipIf(Bun.spawnSync(["python3", "-c", "import tomllib"]).exitCode !== 0)("codex chat derives a standalone account from CODEX_HOME under DEVD_CODEX_ACCOUNTS_DIR", () => {
  const id = "11111111-2222-3333-4444-555555555555";
  mkdirSync(join(dir, id));
  writeFileSync(join(dir, id, "auth.json"), "{}");
  mkdirSync(join(dir, "default-home"));
  writeFileSync(
    join(dir, "agent-bridge"),
    `#!/usr/bin/env bash
if [ "$1" = codex-home ]; then echo "/shadow/$2"; exit 0; fi
echo "$CODEX_HOME|$CODEX_SQLITE_HOME|$DEVD_CODEX_ACCOUNT_ID" > "${dir}/env"
exit 0
`,
  );
  chmodSync(join(dir, "agent-bridge"), 0o755);
  const p = Bun.spawnSync(["bash", LAUNCHER], {
    env: {
      PATH: `${dir}:${process.env.PATH}`,
      DEVD_AGENT: "codex",
      CODEX_HOME: join(dir, "default-home"),
      DEVD_CODEX_ACCOUNTS_DIR: dir,
      DEVD_CODEX_ACCOUNT_ID: id,
    },
    stderr: "pipe",
  });
  expect(p.stderr.toString()).toBe("");
  expect(readFileSync(join(dir, "env"), "utf8").trim()).toBe(`/shadow/${id}|/shadow/${id}/sqlite|${id}`);
});
