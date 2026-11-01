import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const VERSION = "0.1.0";

/** Commit of the checkout devd runs from (read from .git, no subprocess); null outside a git checkout. */
export const COMMIT: string | null = (() => {
  try {
    let dir = import.meta.dir;
    while (!existsSync(join(dir, ".git"))) {
      if (dirname(dir) === dir) return null;
      dir = dirname(dir);
    }
    const git = join(dir, ".git");
    const head = readFileSync(join(git, "HEAD"), "utf8").trim();
    if (!head.startsWith("ref: ")) return /^[0-9a-f]{40}$/.test(head) ? head : null;
    const ref = head.slice(5);
    if (existsSync(join(git, ref))) return readFileSync(join(git, ref), "utf8").trim();
    const packed = readFileSync(join(git, "packed-refs"), "utf8").split("\n").find((l) => l.endsWith(` ${ref}`));
    return packed?.split(" ")[0] ?? null;
  } catch { return null; }
})();
