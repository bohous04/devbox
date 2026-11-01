// The only allowed synchronous execution IN TESTS: preparing repos in tests (git init,
// commit, push to a bare clone). Production devd goes through devd/src/proc.ts run(); the `dev`
// CLI and tools have their own synchronous cli/src/sh.ts (interactive TUI, a different reason).
export function sh(cwd: string, ...cmd: string[]): { code: number; stdout: string; stderr: string } {
  const p = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode ?? 1, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
}
