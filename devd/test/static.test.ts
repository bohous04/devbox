import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StaticFiles } from "../src/static";

const JS = "console.log('x');".repeat(200);   // 3400 B

function dist() {
  const dir = mkdtempSync(join(tmpdir(), "devd-static-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "index.html"), "<html>HELLO</html>");
  writeFileSync(join(dir, "assets", "index-abc123.js"), JS);
  return dir;
}

test("hashed asset: gzip + immutable cache", async () => {
  const s = new StaticFiles(dist());
  const r = (await s.serve("/assets/index-abc123.js", "gzip, deflate, br", null))!;
  expect(r.headers.get("content-encoding")).toBe("gzip");
  expect(r.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  const body = new Uint8Array(await r.arrayBuffer());
  expect(body.byteLength).toBeLessThan(JS.length);
  expect(new TextDecoder().decode(Bun.gunzipSync(body))).toContain("console.log");
});

test("a client without gzip gets uncompressed content", async () => {
  const s = new StaticFiles(dist());
  const r = (await s.serve("/assets/index-abc123.js", null, null))!;
  expect(r.headers.get("content-encoding")).toBeNull();
  expect((await r.text()).length).toBe(JS.length);
});

test("index.html: no-cache, but ETag → second load is 304", async () => {
  const s = new StaticFiles(dist());
  const first = (await s.serve("/", "gzip", null))!;
  expect(first.status).toBe(200);
  expect(first.headers.get("cache-control")).toBe("no-cache");
  const etag = first.headers.get("etag");
  expect(etag).toBeTruthy();

  const second = (await s.serve("/", "gzip", etag))!;
  expect(second.status).toBe(304);
  expect((await second.arrayBuffer()).byteLength).toBe(0);
});

test("unknown path falls back to index.html (SPA fallback), not 404", async () => {
  const s = new StaticFiles(dist());
  const r = (await s.serve("/stats", "gzip", null))!;
  expect(r.status).toBe(200);
  expect(r.headers.get("content-type")).toContain("text/html");
  expect(r.headers.get("cache-control")).toBe("no-cache");
});

test("`..` in the path must not escape the dist directory", async () => {
  const s = new StaticFiles(dist());
  const r = (await s.serve("/../../etc/passwd", null, null))!;
  expect(r.headers.get("content-type")).toContain("text/html"); // fallback, not a file from disk
});

test("missing dist directory → null, not a crash", async () => {
  const s = new StaticFiles(join(tmpdir(), "devd-static-neexistuje"));
  expect(await s.serve("/", null, null)).toBeNull();
});

// `bun run build:dashboard` rewrites index.html with new chunk hashes. If
// StaticFiles kept it in memory forever, after a rebuild without restarting devd the dashboard
// would reference chunks that are no longer on disk — a blank page.
test("a rewritten index.html is reloaded, not served from stale memory", async () => {
  const dir = dist();
  const s = new StaticFiles(dir);
  expect(await (await s.serve("/", null, null))!.text()).toContain("HELLO");

  const path = join(dir, "index.html");
  writeFileSync(path, "<html>NEW BUILD</html>");
  // mtime must differ, otherwise the change could not be detected
  const t = Date.now() + 2000;
  utimesSync(path, new Date(t), new Date(t));

  expect(await (await s.serve("/", null, null))!.text()).toContain("NEW BUILD");
});

test("a hashed asset is not re-read — the name carries the content, revalidation is pointless", async () => {
  const dir = dist();
  const s = new StaticFiles(dir);
  await s.serve("/assets/index-abc123.js", null, null);
  const before = s.cacheSize();
  await s.serve("/assets/index-abc123.js", null, null);
  expect(s.cacheSize()).toBe(before);
});

test("the second call does not compress again — returns the same buffer from cache", async () => {
  const s = new StaticFiles(dist());
  const a = await s.serve("/assets/index-abc123.js", "gzip", null);
  const b = await s.serve("/assets/index-abc123.js", "gzip", null);
  expect(a!.headers.get("etag")).toBe(b!.headers.get("etag"));
  expect(s.cacheSize()).toBe(1);
});

// A dashboard deploy deletes old chunks (`vite build` has emptyOutDir), so an
// already open tab asks for a hash that is not on disk after a menu click. The SPA
// fallback answered that with `200 text/html` and index.html — the browser rejected it
// because of the MIME type, the dynamic import was rejected and the whole app vanished.
// A missing asset must be an honest 404, not HTML.
test("a missing /assets/ chunk is 404, not index.html", async () => {
  const s = new StaticFiles(dist());
  expect(await s.serve("/assets/Subscriptions-STARYHASH.js", "gzip", null)).toBeNull();
});

test("SPA fallback still applies to paths that are not assets", async () => {
  const s = new StaticFiles(dist());
  const r = (await s.serve("/subscriptions", "gzip", null))!;
  expect(r.status).toBe(200);
  expect(r.headers.get("content-type")).toContain("text/html");
});
