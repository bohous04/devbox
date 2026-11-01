import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBackupTar, restoreBackup, type Runner } from "../src/backup";

test("buildBackupTar runs the expected docker + tar sequence", async () => {
  const calls: string[][] = [];
  const run = (_cwd: string, ...cmd: string[]) => { calls.push(cmd); return { code: 0, stdout: "", stderr: "" }; };
  const p = await buildBackupTar({ volume: "claude-home", secretsPath: "/etc/devd/secrets.json", dbPath: "/var/lib/devd/devd.sqlite", tmpDir: "/tmp/bk", run });
  expect(p).toBe("/tmp/bk/backup.tgz");
  // volume export via docker, then a bundling tar including the three artifacts
  expect(calls.some((c) => c[0] === "docker" && c.includes("claude-home:/vol"))).toBe(true);
  expect(calls.some((c) => c[0] === "tar" && c.includes("backup.tgz"))).toBe(true);
});

test("restoreBackup unpacks then restores the volume", async () => {
  const calls: string[][] = [];
  const run = (_cwd: string, ...cmd: string[]) => { calls.push(cmd); return { code: 0, stdout: "", stderr: "" }; };
  await restoreBackup({ volume: "claude-home", secretsPath: "/etc/devd/secrets.json", dbPath: "/var/lib/devd/devd.sqlite", tmpDir: "/tmp/rs", run }, "/tmp/in.tgz");
  expect(calls.some((c) => c[0] === "tar" && c.includes("-xzf"))).toBe(true);
  expect(calls.some((c) => c[0] === "docker" && c.includes("claude-home:/vol"))).toBe(true);
});

test("buildBackupTar throws on a failed docker export", async () => {
  const run = (_c: string, ...cmd: string[]) => ({ code: cmd[0] === "docker" ? 1 : 0, stdout: "", stderr: "boom" });
  // A writable-but-nonexistent tmpDir (not a top-level path like "/t", which mkdirSync
  // can't create on a read-only root filesystem regardless of this test's intent).
  const tmpDir = join(tmpdir(), "devd-backup-fail-test");
  await expect(buildBackupTar({ volume: "v", secretsPath: "/s", dbPath: "/d", tmpDir, run })).rejects.toThrow(/backup failed/);
});

test("restoreBackup throws on a real write failure to secrets dest", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "rs-"));
  writeFileSync(join(tmp, "secrets.json"), "{}"); writeFileSync(join(tmp, "devd.sqlite"), "x"); writeFileSync(join(tmp, "claude-home.tgz"), "x");
  const run = () => ({ code: 0, stdout: "", stderr: "" }); // tar/docker faked ok
  await expect(restoreBackup({ volume: "v", secretsPath: "/no-such-dir/secrets.json", dbPath: join(tmp, "out.sqlite"), tmpDir: tmp, run }, "/in.tgz")).rejects.toThrow();
});

test("restoreBackup cleans staged plaintext from tmpDir", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "rs2-"));
  const dest = mkdtempSync(join(tmpdir(), "dst-"));
  for (const f of ["secrets.json", "devd.sqlite", "claude-home.tgz"]) writeFileSync(join(tmp, f), "x");
  await restoreBackup({ volume: "v", secretsPath: join(dest, "secrets.json"), dbPath: join(dest, "devd.sqlite"), tmpDir: tmp, run: () => ({ code: 0, stdout: "", stderr: "" }) }, "/in.tgz");
  expect(existsSync(join(tmp, "secrets.json"))).toBe(false);
});

test("backup includes the codex-home volume when it is set", async () => {
  const calls: string[][] = [];
  const run = (_cwd: string, ...cmd: string[]) => { calls.push(cmd); return { code: 0, stdout: "", stderr: "" }; };
  await buildBackupTar({ volume: "claude-home", codexVolume: "codex-home", secretsPath: "/nope", dbPath: "/nope", tmpDir: "/tmp/devd-bkp-test", run });
  const joined = calls.map((c) => c.join(" "));
  expect(joined.some((c) => c.includes("codex-home:/vol") && c.includes("codex-home.tgz"))).toBe(true);
});

test("the vault gets into the bundle and back out", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "vaultbk-"));
  const vaultSrc = join(tmp, "vault.age");
  writeFileSync(vaultSrc, "ZASIFROVANO");
  const cmds: string[][] = [];
  const run: Runner = (_cwd, ...cmd) => { cmds.push(cmd); return { code: 0, stdout: "", stderr: "" }; };
  // build: the file is staged under the name vault.age and ends up among the tar members
  writeFileSync(join(tmp, "claude-home.tgz"), "x");
  await buildBackupTar({ volume: "v", secretsPath: "/no/such/secrets.json", vaultPath: vaultSrc, dbPath: "/no/such/db", tmpDir: tmp, run });
  const tarCmd = cmds.find((c) => c[0] === "tar" && c[1] === "czf");
  expect(tarCmd).toBeDefined();
  expect(tarCmd!).toContain("vault.age");

  // restore: vault.age from the bundle is returned to the target path. The target MUST be outside tmpDir —
  // inside, the staging cleanup would delete it after copying (and the test would lie).
  const tmp2 = mkdtempSync(join(tmpdir(), "vaultrs-"));
  const dest = join(mkdtempSync(join(tmpdir(), "vaultdest-")), "vault.age");
  writeFileSync(join(tmp2, "claude-home.tgz"), "x");
  writeFileSync(join(tmp2, "vault.age"), "ZASIFROVANO");
  await restoreBackup({ volume: "v", secretsPath: join(tmp2, "s.json"), vaultPath: dest, dbPath: join(tmp2, "d.sqlite"), tmpDir: tmp2, run }, "/in.tgz");
  expect(existsSync(dest)).toBe(true);
});

test("extra volumes: an existing one is backed up and restored, a missing one is not created", async () => {
  const calls: string[][] = [];
  const run = (_cwd: string, ...cmd: string[]) => {
    calls.push(cmd);
    // grok-home exists, antigravity-home does not (the user never logged in)
    if (cmd[0] === "docker" && cmd[1] === "volume" && cmd[2] === "inspect") return { code: cmd[3] === "grok-home" ? 0 : 1, stdout: "", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const extraVolumes = [{ volume: "grok-home", file: "grok-home.tgz" }, { volume: "antigravity-home", file: "antigravity-home.tgz" }];
  await buildBackupTar({ volume: "claude-home", extraVolumes, secretsPath: "/s", dbPath: "/d", tmpDir: mkdtempSync(join(tmpdir(), "bk-")), run });
  const mounts = calls.filter((c) => c[0] === "docker" && c[1] === "run").map((c) => c.find((a) => a.endsWith(":/vol")));
  expect(mounts).toContain("grok-home:/vol");
  // `docker run -v antigravity-home:/vol` would CREATE the volume as root:root → the session then gets EACCES
  expect(mounts).not.toContain("antigravity-home:/vol");
});

test("extra volumes are restored only from an archive that is present", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "rs-"));
  writeFileSync(join(tmp, "claude-home.tgz"), "x"); writeFileSync(join(tmp, "antigravity-home.tgz"), "x");
  const calls: string[][] = [];
  const run = (_cwd: string, ...cmd: string[]) => { calls.push(cmd); return { code: 0, stdout: "", stderr: "" }; };
  await restoreBackup({ volume: "claude-home", extraVolumes: [{ volume: "grok-home", file: "grok-home.tgz" }, { volume: "antigravity-home", file: "antigravity-home.tgz" }],
    secretsPath: join(tmp, "s.json"), dbPath: join(tmp, "d.sqlite"), tmpDir: tmp, run }, "/in.tgz");
  const mounts = calls.filter((c) => c[0] === "docker").map((c) => c.find((a) => a.endsWith(":/vol")));
  expect(mounts).toContain("antigravity-home:/vol");
  expect(mounts).not.toContain("grok-home:/vol");
});
