// The `dev` CLI and tools are interactive processes where synchronous spawning is fine;
// devd is single-threaded and uses proc.run — hence a separate copy, not an import
// from devd/src/git.ts (that one is async since PR 2 and the noSpawnSync.test.ts guard
// only covers devd/src).
export function sh(cwd: string, ...cmd: string[]): { code: number; stdout: string; stderr: string } {
  const p = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode ?? 1, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
}
