import { closeSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const SHARED_HOME = "/home/dev/.codex-v2/shared";
const SHADOW_ROOT = "/home/dev/.codex-v2/shadow";
/** The image's own CODEX_HOME: the `default` account has no standalone volume. */
const DEFAULT_AUTH = "/home/dev/.codex/auth.json";

/** Same seeding step standalone accounts got in the tmux flow (installed next to codex-account-env.sh). */
const SEED_SCRIPT = "/usr/local/bin/codex-account-seed.py";
const DEFAULT_CODEX_HOME = "/home/dev/.codex";

const SHARED_DIRS = ["sessions", "sqlite", "archived_sessions"];
const SHARED_FILES = ["history.jsonl", "config.toml"];
const ACCOUNT_ID = /^(default|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

export interface HomesPaths {
  sharedHome: string;
  shadowRoot: string;
  defaultAuth: string;
  defaultHome: string;
  seedScript: string;
}

export function shadowHome(accountId: string): string {
  return join(SHADOW_ROOT, accountId);
}

/** Points `link` at `target`. Replaces a different symlink; refuses to replace anything that is not one
 *  (a regular file here could be a copied credential). */
function ensureLink(link: string, target: string): void {
  let st;
  try {
    st = lstatSync(link);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (st) {
    if (!st.isSymbolicLink()) throw new Error(`${link} exists and is not a symlink`);
    if (readlinkSync(link) === target) return;
    rmSync(link);
  }
  try {
    symlinkSync(target, link);
  } catch (err) {
    // Another container preparing the same account got there first; fine if it linked the same target.
    if ((err as NodeJS.ErrnoException).code !== "EEXIST" || readlinkSync(link) !== target) throw err;
  }
}

/** Seeds the shared config.toml once from the default home; an existing non-empty one is left alone. */
function seedSharedConfig(sharedHome: string, defaultHome: string, seedScript: string): void {
  const config = join(sharedHome, "config.toml");
  if (statSync(config).size > 0) return;
  const tmp = mkdtempSync(join(sharedHome, ".seed-"));
  try {
    const run = Bun.spawnSync(["python3", seedScript, defaultHome, tmp], { stderr: "pipe" });
    if (run.exitCode !== 0) throw new Error(`seeding the shared Codex config failed: ${run.stderr.toString().trim()}`);
    // The seed names its own target dir as sqlite_home; the shared sqlite lives in sqlite/.
    const seeded = readFileSync(join(tmp, "config.toml"), "utf8")
      .split("\n")
      .filter((line) => !line.startsWith('"sqlite_home" = '))
      .join("\n");
    const out = join(tmp, "final.toml");
    writeFileSync(out, `${seeded}"sqlite_home" = ${JSON.stringify(join(sharedHome, "sqlite"))}\n`);
    renameSync(out, config);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** A per-account CODEX_HOME that shares threads, history, config and sqlite with every other account
 *  (so a switch is a restart with thread/resume) while auth.json stays the account's own file, linked in place. */
export function prepareShadowHome(accountId: string, accountsRoot: string, paths?: Partial<HomesPaths>): string {
  if (!ACCOUNT_ID.test(accountId)) throw new Error(`invalid Codex account id ${JSON.stringify(accountId)}`);
  const sharedHome = paths?.sharedHome ?? SHARED_HOME;
  const shadowRoot = paths?.shadowRoot ?? SHADOW_ROOT;
  const authSource = accountId === "default" ? (paths?.defaultAuth ?? DEFAULT_AUTH) : join(accountsRoot, accountId, "auth.json");
  let size = 0;
  try {
    size = statSync(authSource).size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (size === 0) throw new Error(`Codex account ${accountId}: ${authSource} is missing or empty (sign the account in first)`);

  const home = join(shadowRoot, accountId);
  mkdirSync(home, { recursive: true });
  for (const name of SHARED_DIRS) {
    mkdirSync(join(sharedHome, name), { recursive: true });
    ensureLink(join(home, name), join(sharedHome, name));
  }
  for (const name of SHARED_FILES) {
    closeSync(openSync(join(sharedHome, name), "a"));
    ensureLink(join(home, name), join(sharedHome, name));
  }
  seedSharedConfig(sharedHome, paths?.defaultHome ?? DEFAULT_CODEX_HOME, paths?.seedScript ?? SEED_SCRIPT);
  ensureLink(join(home, "auth.json"), authSource);
  return home;
}
