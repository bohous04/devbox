import { join } from "node:path";
import { loadConfig, saveConfig, type DevConfig } from "./config";
import { sh } from "./git";

export interface ConfigRepo { read(): DevConfig; write(cfg: DevConfig): Promise<void> }
type R = { code: number; stdout: string; stderr: string };
type Runner = (cwd: string, ...cmd: string[]) => R | Promise<R>;

export function createConfigRepo(configDir: string, run: Runner = (cwd, ...cmd) => sh(cwd, ...cmd)): ConfigRepo {
  const file = join(configDir, "config.json");
  // Writes are serialized: two quick saves from the dashboard would otherwise interleave
  // add/commit/push and the second would commit a half-rewritten file.
  let chain: Promise<void> = Promise.resolve();
  async function doWrite(cfg: DevConfig): Promise<void> {
    saveConfig(file, cfg);
    await run(configDir, "git", "add", "config.json");
    // `git commit`'s "nothing to commit" message is locale-sensitive (LC_ALL isn't
    // threaded through the current sh() signature), so detecting "nothing staged"
    // by matching commit's stdout/stderr text is unreliable. `git diff --cached
    // --quiet` gives a deterministic exit code instead: 0 means nothing staged, in
    // which case there's nothing to commit or push.
    const staged = await run(configDir, "git", "diff", "--cached", "--quiet");
    if (staged.code === 0) return;
    const commit = await run(configDir, "git", "commit", "-m", "chore(config): update from dashboard");
    if (commit.code !== 0)
      throw new Error(`git commit failed: ${commit.stderr.trim() || commit.stdout.trim() || "unknown error"}`);
    const push = await run(configDir, "git", "push");
    if (push.code !== 0) throw new Error(`git push failed: ${push.stderr.trim() || "unknown error"}`);
  }
  return {
    read: () => loadConfig(file),
    write(cfg) {
      const job = chain.then(() => doWrite(cfg));
      chain = job.catch(() => {});   // an error in one write must not block the next ones
      return job;
    },
  };
}
