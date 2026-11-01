import { expect, test } from "bun:test";
import { copyVolumeCmd, poolVolumes, volumeReadArgv, volumesToCopy, volumeWriteArgv } from "../src/instabox/transfer";

const remote = ["docker", "-H", "ssh://ibx-m_1"];

test("volumesToCopy: shared volumes + all pool profiles, invalid ids dropped", () => {
  const ids = { claude: ["a1", "bad id"], codex: ["default", "g1", "BAD"] };
  expect(poolVolumes(ids)).toEqual(["claude-acct-a1", "codex-acct-g1"]);
  expect(volumesToCopy(ids)).toEqual(["claude-home", "codex-home", "grok-home", "claude-acct-a1", "codex-acct-g1"]);
});

test("copyVolumeCmd: tar from the local volume to the remote one, pipefail, root with numeric-owner", () => {
  const c = copyVolumeCmd("claude-home", "devbox:latest", remote);
  expect(c.startsWith("set -o pipefail; ")).toBe(true);
  expect(c).toContain("'docker' 'run' '--rm' '-u' '0' '-v' 'claude-home:/v:ro' 'devbox:latest' tar --numeric-owner '--exclude=./sessions'");
  expect(c).toContain(" -C /v -cf - . | ");
  expect(c).toContain("| 'docker' '-H' 'ssh://ibx-m_1' 'run' '--rm' '-i' '-u' '0' '-v' 'claude-home:/v' 'devbox:latest' tar --numeric-owner -C /v -xf -");
});

test("volumeReadArgv / volumeWriteArgv", () => {
  expect(volumeReadArgv(["docker"], "img", "codex-home", "auth.json"))
    .toEqual(["docker", "run", "--rm", "-u", "0", "-v", "codex-home:/v", "img", "sh", "-c", "cat /v/auth.json 2>/dev/null || exit 3"]);
  expect(volumeWriteArgv(remote, "img", "claude-acct-a1", ".credentials.json"))
    .toEqual([...remote, "run", "--rm", "-i", "-u", "0", "-v", "claude-acct-a1:/v", "img", "sh", "-c",
      "umask 077; cat > /v/.credentials.json.devd-tmp && chown 1000:1000 /v/.credentials.json.devd-tmp && mv /v/.credentials.json.devd-tmp /v/.credentials.json"]);
});

test("copyVolumeCmd skips history and SQLite, but not logins and config", () => {
  const c = copyVolumeCmd("codex-home", "devbox:latest", remote);
  for (const e of ["./sessions", "./archived_sessions", "./worktrees", "./projects", "*.sqlite", "*.sqlite-wal"]) expect(c).toContain(`'--exclude=${e}'`);
  for (const keep of ["auth.json", ".credentials.json", "config.toml", "settings.json", "plugins", "skills", ".claude.json"]) expect(c).not.toContain(keep);
});
