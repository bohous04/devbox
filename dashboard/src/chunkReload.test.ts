import { expect, test } from "bun:test";
import { RELOAD_GUARD_MS, isChunkLoadError, recoveryFor } from "./chunkReload";

// Messages that actually arrive when a lazy chunk cannot be fetched. Each
// browser says it differently, hence all three families here — Chrome, Firefox
// and Safari. Captured live in a repro (Chromium 1.62).
const CHROME = new Error("Failed to fetch dynamically imported module: https://dev.example.com/assets/Subscriptions-DSiLZVIq.js");
const FIREFOX = new Error("error loading dynamically imported module: https://dev.example.com/assets/Stats-DGeL4oH_.js");
const SAFARI = new Error("Importing a module script failed.");
const MIME = new TypeError('Failed to load module script: Expected a JavaScript-or-Wasm module script but the server responded with a MIME type of "text/html".');
const CSS = new Error("Unable to preload CSS for /assets/Terminal-6GBZ9nXN.css");

test("recognizes the chunk-fetch failure message across browsers", () => {
  for (const e of [CHROME, FIREFOX, SAFARI, MIME, CSS]) expect(isChunkLoadError(e)).toBe(true);
});

test("an ordinary component error is not a chunk fetch error", () => {
  expect(isChunkLoadError(new TypeError("Cannot read properties of undefined (reading 'filter')"))).toBe(false);
  expect(isChunkLoadError(new Error("fetch failed"))).toBe(false);
  expect(isChunkLoadError(null)).toBe(false);
  expect(isChunkLoadError("Failed to fetch dynamically imported module: x")).toBe(true);
});

// A missing chunk means one thing only: a deploy happened meanwhile and the tab holds old
// hashes. Reloading the page fetches the new index.html and that solves it.
test("missing chunk the first time → reload the page", () => {
  expect(recoveryFor(CHROME, null, 1_000_000)).toBe("reload");
});

// If the chunk were still missing after a reload, a second reload would fix nothing and the page
// would loop forever. So after the first attempt a readable card is shown.
test("missing chunk right after a reload → card, not another reload", () => {
  expect(recoveryFor(CHROME, 1_000_000, 1_000_000 + RELOAD_GUARD_MS - 1)).toBe("report");
});

test("missing chunk after another deploy (outside the window) → reload again", () => {
  expect(recoveryFor(CHROME, 1_000_000, 1_000_000 + RELOAD_GUARD_MS + 1)).toBe("reload");
});

test("an error that is not about a chunk is never handled by a reload", () => {
  expect(recoveryFor(new TypeError("x.filter is not a function"), null, 1_000_000)).toBe("report");
});
