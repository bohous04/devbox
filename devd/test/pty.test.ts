import { expect, test } from "bun:test";
import { sh } from "./helpers/sh";
import { ensureDevboxPty, frame, realSpawnPty, tmuxCmd, type PtyRunner } from "../src/pty";
import { hasDocker, RUN_ID } from "./helpers/docker";
import { setRemoteDocker } from "../src/dockerTarget";

const PTY = "/usr/local/bin/devbox-pty";
// Runner that only records commands and answers `test -x` according to `present`.
function recordingRunner(present: boolean, srcExists = true): { runner: PtyRunner; cmds: string[][] } {
  const cmds: string[][] = [];
  const runner: PtyRunner = {
    run: (cmd) => { cmds.push(cmd); return { exitCode: cmd.includes("test") ? (present ? 0 : 1) : 0 }; },
    exists: () => srcExists,
  };
  return { runner, cmds };
}

test("ensureDevboxPty: binary present → only checks, does not copy", async () => {
  const { runner, cmds } = recordingRunner(true);
  await ensureDevboxPty("ctr", "/src/devbox-pty", runner);
  expect(cmds).toEqual([["docker", "exec", "ctr", "test", "-x", PTY]]);
});

test("ensureDevboxPty: binary missing (old image) → docker cp + chmod", async () => {
  const { runner, cmds } = recordingRunner(false);
  await ensureDevboxPty("ctr", "/src/devbox-pty", runner);
  expect(cmds).toEqual([
    ["docker", "exec", "ctr", "test", "-x", PTY],
    ["docker", "cp", "/src/devbox-pty", `ctr:${PTY}`],
    ["docker", "exec", "-u", "0", "ctr", "chmod", "755", PTY],
  ]);
});

test("ensureDevboxPty: source missing too → does not copy (exec fails as before)", async () => {
  const { runner, cmds } = recordingRunner(false, false);
  await ensureDevboxPty("ctr", "/src/devbox-pty", runner);
  expect(cmds).toEqual([["docker", "exec", "ctr", "test", "-x", PTY]]);
});

test("ensureDevboxPty: runner may return a Promise", async () => {
  const cmds: string[][] = [];
  const runner: PtyRunner = {
    run: async (cmd) => { cmds.push(cmd); return { exitCode: cmd.includes("test") ? 1 : 0 }; },
    exists: () => true,
  };
  await ensureDevboxPty("ctr", "/src/devbox-pty", runner);
  expect(cmds.some((c) => c[0] === "docker" && c[1] === "cp")).toBe(true);
});

test("ensureDevboxPty targets the remote docker of an InstaBox session", async () => {
  setRemoteDocker("ctr", "ibx-m_1");
  try {
    const { runner, cmds } = recordingRunner(false);
    await ensureDevboxPty("ctr", "/src/devbox-pty", runner);
    expect(cmds).toEqual([
      ["docker", "-H", "ssh://ibx-m_1", "exec", "ctr", "test", "-x", PTY],
      ["docker", "-H", "ssh://ibx-m_1", "cp", "/src/devbox-pty", `ctr:${PTY}`],
      ["docker", "-H", "ssh://ibx-m_1", "exec", "-u", "0", "ctr", "chmod", "755", PTY],
    ]);
  } finally { setRemoteDocker("ctr", null); }
});

test("tmuxCmd: grouped session from the given target", () => {
  const cmd = tmuxCmd("web-abc-1", "main-2");
  expect(cmd).toContain("new-session -A -d -s main-2");
  expect(cmd).toContain("new-session -t main-2 -s web-abc-1");
  expect(cmd).toContain("destroy-unattached on");
});

test("tmuxCmd: fallback to claude-launch when an old image lacks agent-launch", () => {
  const cmd = tmuxCmd("web-abc-1", "main-2");
  expect(cmd).toContain("if [ -x /usr/local/bin/agent-launch ]");
  expect(cmd).toContain("else exec /usr/local/bin/claude-launch; fi");
});

test("frame: [type][len big-endian][payload]", () => {
  const f = frame("i", "ab");
  expect(f[0]).toBe("i".charCodeAt(0));
  expect(Array.from(f.slice(1, 5))).toEqual([0, 0, 0, 2]);
  expect(new TextDecoder().decode(f.slice(5))).toBe("ab");
  const r = frame("r", "80,24");
  expect(r[0]).toBe("r".charCodeAt(0));
  expect(new TextDecoder().decode(r.slice(5))).toBe("80,24");
});

const hasImage = hasDocker && sh(process.cwd(), "docker", "images", "-q", "devbox:test").stdout.trim() !== "";

// Real transport: the PTY is allocated inside the container (devbox-pty), the host only pipes
// frames. Independent of the host OS, so this test holds for the VPS too.
test.skipIf(!hasImage)("realSpawnPty: echo roundtrip over the in-container PTY bridge", async () => {
  const ctr = `devd-pty-test-${RUN_ID}`;
  sh(process.cwd(), "docker", "rm", "-f", ctr);
  sh(process.cwd(), "docker", "run", "-d", "--name", ctr, "devbox:test", "sleep", "infinity");
  try {
    sh(process.cwd(), "docker", "cp", `${import.meta.dir}/../../image/devbox-pty`, `${ctr}:/usr/local/bin/devbox-pty`);
    sh(process.cwd(), "docker", "exec", "-u", "0", ctr, "chmod", "+x", "/usr/local/bin/devbox-pty");
    // agent-launch → bash (no claude/codex login), so main has a shell to echo right away.
    // `chmod +x` is REQUIRED, not cosmetic: `printf >` creates the file with mode 644 and
    // tmuxCmd picks by `[ -x /usr/local/bin/agent-launch ]`. Without the bit the
    // stub is skipped and it falls back to `claude-launch`, which IS in the image — it starts
    // claude without a login, no shell, nobody to return the echo, and the test runs into
    // the eight-second timeout. A silent failure that does not look like a missing chmod.
    sh(process.cwd(), "docker", "exec", "-u", "0", ctr, "sh", "-c", "printf '#!/bin/sh\\nexec bash\\n' > /usr/local/bin/agent-launch && chmod +x /usr/local/bin/agent-launch");

    const pty = realSpawnPty(ctr, "web-test-1", "main", 80, 24);
    let buf = "";
    const got = new Promise<boolean>((resolve) => {
      pty.onData((d) => { buf += d; if (buf.includes("PTYMARK")) resolve(true); });
      setTimeout(() => resolve(false), 8000);
    });
    setTimeout(() => { pty.resize(100, 30); pty.write("echo PTYMARK\r"); }, 1500);
    const ok = await got;
    pty.kill();
    expect(ok).toBe(true);
  } finally {
    sh(process.cwd(), "docker", "rm", "-f", ctr);
  }
}, 30_000);
