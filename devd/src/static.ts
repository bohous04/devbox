import { statSync } from "node:fs";
import { join, normalize } from "node:path";

/** Minimum size from which we gzip. Below it the overhead is greater than the savings. */
const GZIP_MIN = 1024;
const GZIPPABLE = /^(text\/|application\/(javascript|json|xml)|image\/svg)/;

interface Entry { raw: Uint8Array; gz: Uint8Array | null; type: string; etag: string }

/** Weak ETag from size and mtime — also serves as the fingerprint for cache revalidation. */
function etagOf(st: { size: number; mtimeMs: number }): string {
  return `W/"${st.size.toString(16)}-${Math.round(st.mtimeMs).toString(16)}"`;
}

/** Dashboard static files. The original handler returned `new Response(Bun.file(...))`, which
 *  means no compression and no validator at all — so the browser had nothing to
 *  revalidate and downloaded the whole 1.49MB bundle on EVERY page load.
 *
 *  The content is read and gzipped once into memory — gzipping 1.5 MB on every request would
 *  hurt more on the single JS thread than the download. Hashed assets are kept
 *  forever (the name carries the content), `index.html` is revalidated by mtime: a dashboard rebuild
 *  overwrites it with new hashes, and relying on every deploy restarting
 *  devd meant serving references to chunks that are no longer on disk. */
export class StaticFiles {
  private cache = new Map<string, Entry>();
  constructor(private dir: string) {}

  cacheSize(): number { return this.cache.size; }

  /** `revalidate` = check mtime and reload on change. Applies to index.html:
   *  `bun run build:dashboard` overwrites it with new chunk hashes, and if the
   *  cache kept it forever, after a rebuild without a devd restart the dashboard would reference
   *  chunks that are no longer on disk. Hashed assets need no revalidation
   *  — there the name carries the content. */
  private async load(abs: string, revalidate = false): Promise<Entry | null> {
    const hit = this.cache.get(abs);
    if (hit && !revalidate) return hit;
    if (hit) {
      const st = statSync(abs, { throwIfNoEntry: false });
      if (st && hit.etag === etagOf(st)) return hit;
    }
    const f = Bun.file(abs);
    if (!(await f.exists())) return null;
    const raw = new Uint8Array(await f.arrayBuffer());
    const type = f.type || "application/octet-stream";
    const gz = raw.byteLength >= GZIP_MIN && GZIPPABLE.test(type) ? Bun.gzipSync(raw) : null;
    const entry: Entry = { raw, gz, type, etag: etagOf(statSync(abs)) };
    this.cache.set(abs, entry);
    return entry;
  }

  async serve(reqPath: string, acceptEncoding: string | null, ifNoneMatch: string | null): Promise<Response | null> {
    // normalize() eliminates `..`; join would otherwise let it escape the dist directory.
    const rel = normalize(reqPath === "/" ? "/index.html" : reqPath).replace(/^(\.\.[/\\])+/, "");
    const abs = join(this.dir, rel);
    // Hashed assets (/assets/…) carry the content in the name — they are not revalidated.
    const hashed = abs.startsWith(join(this.dir, "assets") + "/");
    const direct = await this.load(abs, !hashed);
    // SPA fallback: /stats and friends must return index.html, not 404. It must NOT
    // apply to `/assets/`, though: a deploy deletes old chunks (`emptyOutDir`), so an
    // already open tab asks, after a menu click, for a hash that is not on disk.
    // Answering that with the index means sending `200 text/html` where the browser
    // expects a module — it rejects it on the MIME check, the dynamic import is rejected
    // and without an error boundary the whole application disappears. An honest 404 is a readable error
    // that the dashboard can catch and offer to load the new version.
    const entry = direct ?? (hashed ? null : await this.load(join(this.dir, "index.html"), true));
    if (!entry) return null;

    // Hashed assets from vite are immutable; index.html must be revalidated,
    // otherwise a reference to the old bundle would remain after a deploy.
    const cacheControl = direct && hashed ? "public, max-age=31536000, immutable" : "no-cache";

    if (ifNoneMatch && ifNoneMatch === entry.etag) {
      return new Response(null, { status: 304, headers: { etag: entry.etag, "cache-control": cacheControl } });
    }
    const useGz = entry.gz !== null && (acceptEncoding ?? "").includes("gzip");
    const headers: Record<string, string> = {
      "content-type": entry.type,
      "cache-control": cacheControl,
      etag: entry.etag,
      vary: "Accept-Encoding",
    };
    if (useGz) headers["content-encoding"] = "gzip";
    return new Response(useGz ? entry.gz! : entry.raw, { headers });
  }
}
