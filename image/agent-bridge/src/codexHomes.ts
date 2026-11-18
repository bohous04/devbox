import { closeSync, lstatSync, mkdirSync, openSync, readlinkSync, rmSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";

export const SHARED_HOME = "/home/dev/.codex-v2/shared";
const SHADOW_ROOT = "/home/dev/.codex-v2/shadow";
/** The image's own CODEX_HOME: the `default` account has no standalone volume. */
const DEFAULT_AUTH = "/home/dev/.codex/auth.json";

const SHARED_DIRS = ["sessions", "sqlite", "archived_sessions"];
const SHARED_FILES = ["history.jsonl", "config.toml"];
const ACCOUNT_ID = /^(default|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

export interface HomesPaths {
  sharedHome: string;
  shadowRoot: string;
  defaultAuth: string;
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
  symlinkSync(target, link);
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
    mkdirSync(sharedHome, { recursive: true });
    closeSync(openSync(join(sharedHome, name), "a"));
    ensureLink(join(home, name), join(sharedHome, name));
  }
  ensureLink(join(home, "auth.json"), authSource);
  return home;
}
