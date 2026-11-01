import { writeFileSync } from "node:fs";
import { join } from "node:path";

/** Materializes an SSH key from 1Password to disk (once, with an in-flight cache) and returns
 *  its path. Concurrent calls for the SAME key share one `readKey` and one write —
 *  without this (check-then-act via `await readKey(...)`) two concurrent callers
 *  (typically two sessions being created at once for the same project) would both miss the cache,
 *  both run `op read` and both `writeFileSync` the same path; `writeFileSync`
 *  truncates before writing, so a container that already has the file bind-mounted and
 *  open could read an empty/truncated key. The same single-flight shape as
 *  `memoAsyncStrict` in cache.ts — it just caches the path on disk, not the value.
 *
 *  A failed read is not cached (the promise is removed from the map after rejection), so
 *  the next call for the same key retries, the same convention as `memoAsyncStrict`. */
export function createProdKeyPath(
  dir: string,
  readKey: (key: string) => Promise<string>,
  chown: (path: string) => void = () => {},
): (key: string) => Promise<string> {
  const cache = new Map<string, Promise<string>>();
  return (key: string): Promise<string> => {
    let p = cache.get(key);
    if (!p) {
      p = (async () => {
        const path = join(dir, key);
        writeFileSync(path, await readKey(key), { mode: 0o600 });
        chown(path);
        return path;
      })();
      p.catch(() => cache.delete(key));
      cache.set(key, p);
    }
    return p;
  };
}
