import { expect, test } from "bun:test";
import { appendFileSync, chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../src/sessions";
import { insertSession, openDb } from "../src/db";
import { DEFAULT_CONFIG } from "../src/config";

// The host's docker wrapper (infra/storage-guard/host-docker.py) lets `docker rm` of a session container through only
// once it is backed up offsite, and waits for that only 40 s: replacing a container that was never ended (a stopped
// session reopened with a new env, a recreate) timed out at 60 s every time while the backup ran on (2026-11-24).
// The backup now runs up front with its own long cap, as for an end.
test("recreate backs the old container up before it removes it", async () => {
  const root = mkdtempSync(join(tmpdir(), "replace-"));
  const log = join(root, "log");
  writeFileSync(log, "");
  writeFileSync(join(root, "docker"), `#!/usr/bin/env bash\necho "docker $*" >> ${log}\nexit 0\n`);
  chmodSync(join(root, "docker"), 0o755);
  const orig = process.env.PATH;
  process.env.PATH = `${root}:${orig}`;
  try {
    const db = openDb(":memory:");
    insertSession(db, {
      id: "dev-a-b", folder: "acme", project: "a", repo: "b", container: "dev-a-b", port_base: 41500,
      status: "stopped", solo: 0, created_at: 0, last_active_at: 0, important: 0, runtime: "tmux",
    });
    const mgr = new SessionManager({
      db, cfg: DEFAULT_CONFIG, root, image: "unused", extraMounts: [], cmd: [], controlRoot: join(root, "ctl"),
      preserveForEnd: async (c) => { appendFileSync(log, `preserve ${c}\n`); },
    });
    await mgr.recreate("dev-a-b", "test").catch(() => {});
    const lines = readFileSync(log, "utf8").split("\n").filter((l) => l === "preserve dev-a-b" || l.startsWith("docker rm"));
    expect(lines[0]).toBe("preserve dev-a-b");
    expect(lines[1]).toStartWith("docker rm -f dev-a-b");
  } finally { process.env.PATH = orig; }
});

test("a failed backup before a replace says what it was for, and nothing is removed", async () => {
  const root = mkdtempSync(join(tmpdir(), "replace-"));
  const log = join(root, "log");
  writeFileSync(log, "");
  writeFileSync(join(root, "docker"), `#!/usr/bin/env bash\necho "docker $*" >> ${log}\nexit 0\n`);
  chmodSync(join(root, "docker"), 0o755);
  const orig = process.env.PATH;
  process.env.PATH = `${root}:${orig}`;
  try {
    const db = openDb(":memory:");
    insertSession(db, {
      id: "dev-a-b", folder: "acme", project: "a", repo: "b", container: "dev-a-b", port_base: 41500,
      status: "stopped", solo: 0, created_at: 0, last_active_at: 0, important: 0, runtime: "tmux",
    });
    const mgr = new SessionManager({
      db, cfg: DEFAULT_CONFIG, root, image: "unused", extraMounts: [], cmd: [], controlRoot: join(root, "ctl"),
      preserveForEnd: async () => { throw new Error("backup before ending failed (journalctl -u x): borg died"); },
    });
    await expect(mgr.recreate("dev-a-b", "test")).rejects.toThrow(
      "dev-a-b: its old container must be backed up offsite before it is replaced, and that failed: backup before ending failed (journalctl -u x): borg died");
    expect(readFileSync(log, "utf8")).not.toContain("docker rm");
  } finally { process.env.PATH = orig; }
});
