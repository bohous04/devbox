/** Detecting and handling the "lazy chunk cannot be downloaded" error.
 *
 *  Since code splitting was introduced the dashboard is assembled from hashed chunks
 *  that are downloaded only on the first visit to a given page. A deploy, however,
 *  overwrites all of them (`vite build` wipes the output directory), so a tab open across
 *  a deploy asks, on a menu click, for a file that is no longer on the server.
 *  The import is rejected, React throws that error during render and without a rescue
 *  the whole app including the menu disappears — a blank white page.
 *
 *  An expired Cloudflare Access session produces the same message: the chunk request
 *  ends in a redirect to the login HTML, which the browser rejects as a module.
 *  Both are fixed by reloading the page, in the second case via signing in. */

/** How long after an automatic reload another one will not start. A reload takes a fraction
 *  of a second; when the chunk is still missing after it, a second attempt will not help and the page
 *  would just spin in a loop. */
export const RELOAD_GUARD_MS = 10_000;

/** Every browser reports it differently, so we search for a substring, not an exact match. */
const CHUNK_ERROR_PATTERNS = [
  "failed to fetch dynamically imported module",   // Chrome / Edge
  "error loading dynamically imported module",     // Firefox
  "importing a module script failed",              // Safari
  "failed to load module script",                  // MIME kontrola modulu
  "expected a javascript-or-wasm module script",
  "unable to preload css",                         // vite, missing CSS chunk
  "loading chunk",                                 // older bundler wording
];

export function isChunkLoadError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  const low = msg.toLowerCase();
  return CHUNK_ERROR_PATTERNS.some((p) => low.includes(p));
}

/** `reload` = fetch the page again (a new index.html with valid hashes arrives),
 *  `report` = show a readable error card and leave the decision to the user. */
export function recoveryFor(err: unknown, lastReloadAt: number | null, now: number): "reload" | "report" {
  if (!isChunkLoadError(err)) return "report";
  if (lastReloadAt !== null && now - lastReloadAt < RELOAD_GUARD_MS) return "report";
  return "reload";
}
