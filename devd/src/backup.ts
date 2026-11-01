import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { run as runProc, timeoutFor } from "./proc";

type R = { code: number; stdout: string; stderr: string };
export type Runner = (cwd: string, ...cmd: string[]) => R | Promise<R>;
// The backup has its own 30 min cap (docker export + tar of large volumes can take a while) —
// it goes through proc.run, not git.ts sh(), which has shorter timeouts for git operations.
const defaultRun: Runner = (cwd, ...cmd) => runProc(cmd, { cwd, timeoutMs: timeoutFor("BACKUP") });

export interface BackupDeps { volume: string; codexVolume?: string; extraVolumes?: { volume: string; file: string }[]; secretsPath: string; vaultPath?: string; dbPath: string; tmpDir: string; run?: Runner }

// The staged plaintext artifacts inside tmpDir. They hold secrets + the live sqlite
// db, so they're shredded from tmpDir once they're safely inside backup.tgz (build)
// or copied back out to their real homes (restore).
// vault.age belongs in the backup just like secrets.json — after the switch to the vault it is the
// ONLY carrier of secrets, and without it the bundle would be unusable for restore.
const STAGED = ["claude-home.tgz", "codex-home.tgz", "secrets.json", "vault.age", "devd.sqlite"] as const;

// `STAGED` + archives of the other agent home volumes (grok-home, antigravity-home) —
// their names are dynamic (d.extraVolumes), so they cannot be in a fixed array.
const staged = (d: BackupDeps): string[] => [...STAGED, ...(d.extraVolumes ?? []).map((v) => v.file)];

function ok(r: { code: number; stderr: string }, what: string) {
  if (r.code !== 0) throw new Error(`${what} failed: ${r.stderr.trim() || "unknown error"}`);
}

export async function buildBackupTar(d: BackupDeps): Promise<string> {
  const run = d.run ?? defaultRun;
  mkdirSync(d.tmpDir, { recursive: true });
  // 1) export the claude-home volume into tmpDir/claude-home.tgz
  ok(await run(d.tmpDir, "docker", "run", "--rm", "-v", `${d.volume}:/vol`, "-v", `${d.tmpDir}:/out`,
    "alpine", "sh", "-c", "tar czf /out/claude-home.tgz -C /vol ."), "backup");
  // codex-home is optional (the user may never have signed in to OpenAI).
  if (d.codexVolume) {
    ok(await run(d.tmpDir, "docker", "run", "--rm", "-v", `${d.codexVolume}:/vol`, "-v", `${d.tmpDir}:/out`,
      "alpine", "sh", "-c", "tar czf /out/codex-home.tgz -C /vol ."), "codex backup");
  }
  // 2) stage secrets + sqlite next to it. An absent SOURCE is tolerated (loadSecrets
  // returns {} when the file is missing), but a genuine copy error now propagates
  // instead of being silently swallowed.
  if (existsSync(d.secretsPath)) copyFileSync(d.secretsPath, join(d.tmpDir, "secrets.json"));
  if (d.vaultPath && existsSync(d.vaultPath)) copyFileSync(d.vaultPath, join(d.tmpDir, "vault.age"));
  if (existsSync(d.dbPath)) copyFileSync(d.dbPath, join(d.tmpDir, "devd.sqlite"));
  // Other agent home volumes (grok-home, antigravity-home). Only EXISTING ones: `docker run
  // -v name:/vol` would create a missing volume as root:root and sessions could then not write
  // into their home (same bug as with grok-home, seed-grok-hooks.sh).
  for (const v of d.extraVolumes ?? []) {
    if ((await run(d.tmpDir, "docker", "volume", "inspect", v.volume)).code !== 0) continue;
    ok(await run(d.tmpDir, "docker", "run", "--rm", "-v", `${v.volume}:/vol`, "-v", `${d.tmpDir}:/out`,
      "alpine", "sh", "-c", `tar czf /out/${v.file} -C /vol .`), `backup of ${v.volume}`);
  }
  // 3) bundle the present members into one backup.tgz. secrets.json / devd.sqlite may
  // legitimately be absent, and tar hard-fails on a missing member — so only tar the
  // files actually staged (claude-home.tgz is always present after step 1). Relative
  // member names: run()'s cwd is tmpDir, and the unit tests assert on the literal
  // "backup.tgz" argument rather than an absolute path.
  const out = join(d.tmpDir, "backup.tgz");
  const members = staged(d).filter((f) => existsSync(join(d.tmpDir, f)));
  ok(await run(d.tmpDir, "tar", "czf", basename(out), "-C", d.tmpDir, ...members), "bundle backup");
  // 4) shred the staged plaintext — secrets + db now live inside backup.tgz
  for (const f of staged(d)) rmSync(join(d.tmpDir, f), { force: true });
  return out;
}

export async function restoreBackup(d: BackupDeps, tarPath: string): Promise<void> {
  const run = d.run ?? defaultRun;
  mkdirSync(d.tmpDir, { recursive: true });
  ok(await run(d.tmpDir, "tar", "-xzf", tarPath, "-C", d.tmpDir), "bundle restore");
  // restore the volume contents
  ok(await run(d.tmpDir, "docker", "run", "--rm", "-v", `${d.volume}:/vol`, "-v", `${d.tmpDir}:/in`,
    "alpine", "sh", "-c", "tar xzf /in/claude-home.tgz -C /vol"), "volume restore");
  if (d.codexVolume && existsSync(join(d.tmpDir, "codex-home.tgz"))) {
    ok(await run(d.tmpDir, "docker", "run", "--rm", "-v", `${d.codexVolume}:/vol`, "-v", `${d.tmpDir}:/in`,
      "alpine", "sh", "-c", "tar xzf /in/codex-home.tgz -C /vol"), "codex volume restore");
  }
  for (const v of d.extraVolumes ?? []) {
    if (!existsSync(join(d.tmpDir, v.file))) continue;
    ok(await run(d.tmpDir, "docker", "run", "--rm", "-v", `${v.volume}:/vol`, "-v", `${d.tmpDir}:/in`,
      "alpine", "sh", "-c", `tar xzf /in/${v.file} -C /vol`), `restore of ${v.volume}`);
  }
  // restore secrets + sqlite. An absent extracted file is tolerated, but a real write
  // error to the destination now propagates — the caller must not report success on a
  // half-applied restore.
  if (existsSync(join(d.tmpDir, "secrets.json"))) copyFileSync(join(d.tmpDir, "secrets.json"), d.secretsPath);
  if (d.vaultPath && existsSync(join(d.tmpDir, "vault.age"))) copyFileSync(join(d.tmpDir, "vault.age"), d.vaultPath);
  if (existsSync(join(d.tmpDir, "devd.sqlite"))) copyFileSync(join(d.tmpDir, "devd.sqlite"), d.dbPath);
  // shred the extracted plaintext staging files
  for (const f of staged(d)) rmSync(join(d.tmpDir, f), { force: true });
}
