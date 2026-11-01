export const VERSION = "0.1.0";

/** Git commit devd runs from, read once at startup (null outside a git checkout). The
 *  updater (infra/devbox-update.ts) compares it after a restart to prove the new code runs. */
export const COMMIT: string | null = (() => {
  try {
    const r = Bun.spawnSync(["git", "-C", import.meta.dir, "rev-parse", "HEAD"], { stderr: "ignore" });
    const sha = r.exitCode === 0 ? r.stdout.toString().trim() : "";
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
})();
