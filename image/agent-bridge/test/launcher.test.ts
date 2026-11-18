import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
