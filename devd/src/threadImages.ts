import { existsSync, lstatSync, mkdirSync, renameSync, rmSync, writeFileSync, type Stats } from "node:fs";
import { join } from "node:path";

/** Images a chat message may carry, by the extension they are stored under, with their media type. */
export const THREAD_IMAGE_TYPES = { png: "image/png", jpg: "image/jpeg", webp: "image/webp", gif: "image/gif" } as const;
export type ThreadImageExt = keyof typeof THREAD_IMAGE_TYPES;
export const THREAD_IMAGE_KINDS = "png, jpeg, webp or gif";
/** Per image, whoever uploads it (the dashboard sends at most 4 MB and 2048 px; Claude takes up to 5 MB and 8000 px). */
export const MAX_THREAD_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_THREAD_IMAGE_SIDE = 8000;

/** A chat image devd refuses: 415 for what is not a readable png/jpeg/webp/gif, 413 for one over the caps. */
export class ThreadImageError extends Error {
  constructor(message: string, public status: 413 | 415) { super(message); }
}

const startsWith = (b: Uint8Array, sig: number[], at = 0) => b.length >= at + sig.length && sig.every((x, i) => b[at + i] === x);
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

/** The image type by the file's own bytes (not its name or the request's claim); null for anything else. */
export function sniffImage(b: Uint8Array): ThreadImageExt | null {
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (startsWith(b, [0xff, 0xd8, 0xff])) return "jpg";
  if (startsWith(b, ascii("GIF87a")) || startsWith(b, ascii("GIF89a"))) return "gif";
  if (startsWith(b, ascii("RIFF")) && startsWith(b, ascii("WEBP"), 8)) return "webp";
  return null;
}

const be16 = (b: Uint8Array, i: number) => (b[i]! << 8) | b[i + 1]!;
const le16 = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8);
const le24 = (b: Uint8Array, i: number) => le16(b, i) | (b[i + 2]! << 16);

/** Width and height from the image's header; null when the header is cut short or has no size. */
export function imageSize(b: Uint8Array, ext: ThreadImageExt): { width: number; height: number } | null {
  const has = (n: number) => b.length >= n;
  switch (ext) {
    case "png":
      if (!has(24)) return null;
      return { width: new DataView(b.buffer, b.byteOffset, b.length).getUint32(16), height: new DataView(b.buffer, b.byteOffset, b.length).getUint32(20) };
    case "gif":
      return has(10) ? { width: le16(b, 6), height: le16(b, 8) } : null;
    case "webp": {
      if (startsWith(b, ascii("VP8X"), 12)) return has(30) ? { width: le24(b, 24) + 1, height: le24(b, 27) + 1 } : null;
      if (startsWith(b, ascii("VP8L"), 12)) {
        if (!has(25)) return null;
        const bits = (b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24)) >>> 0;
        return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
      }
      if (startsWith(b, ascii("VP8 "), 12)) return has(30) ? { width: le16(b, 26) & 0x3fff, height: le16(b, 28) & 0x3fff } : null;
      return null;
    }
    case "jpg": {
      // Walk the segments to the first start-of-frame marker (SOF0–SOF15 except DHT, JPG and DAC).
      let i = 2;
      while (has(i + 4)) {
        if (b[i] !== 0xff) return null;
        const marker = b[i + 1]!;
        if (marker === 0xff) { i++; continue; }
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) { i += 2; continue; }
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return has(i + 9) ? { width: be16(b, i + 7), height: be16(b, i + 5) } : null;
        }
        i += 2 + be16(b, i + 2);
      }
      return null;
    }
  }
}

/** `<root>/_inbox/<sessionId>`: the session's own chat images, under `/inbox/<sessionId>` in every container. */
const sessionDir = (root: string, sessionId: string) => join(root, "_inbox", sessionId);

/** Stores a chat image as `<uuid>.<ext>` in the session's dir and returns its container path. Throws ThreadImageError
 *  for a file that is not a png, jpeg, webp or gif, or one over 5 MB or 8000 px on a side. */
export function stageThreadImage(root: string, sessionId: string, bytes: Uint8Array): string {
  const ext = sniffImage(bytes);
  if (ext === null) throw new ThreadImageError(`Only ${THREAD_IMAGE_KINDS} images can be attached`, 415);
  if (bytes.length > MAX_THREAD_IMAGE_BYTES) {
    throw new ThreadImageError(`The image is ${(bytes.length / 1024 / 1024).toFixed(1)} MB; chat images may be at most 5 MB`, 413);
  }
  const size = imageSize(bytes, ext);
  if (size === null) throw new ThreadImageError("The image's size could not be read", 415);
  if (size.width > MAX_THREAD_IMAGE_SIDE || size.height > MAX_THREAD_IMAGE_SIDE) {
    throw new ThreadImageError(`The image is ${size.width}×${size.height} px; chat images may be at most ${MAX_THREAD_IMAGE_SIDE} px on a side`, 413);
  }
  const dir = sessionDir(root, sessionId);
  mkdirSync(dir, { recursive: true });
  if (!lstatSync(dir).isDirectory()) throw new Error("the session's inbox must be a directory, not a symlink");
  const name = `${crypto.randomUUID()}.${ext}`;
  writeFileSync(join(dir, name), bytes, { flag: "wx" });
  return `/inbox/${sessionId}/${name}`;
}

const NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp|gif)$/;

/** The host file behind `name` when it is an image `stageThreadImage` stored for this session; null otherwise. */
export function threadImageByName(root: string, sessionId: string, name: string): { file: string; type: string } | null {
  return imageInDir(sessionDir(root, sessionId), name);
}

/** The image `name` (a name stageThreadImage gave) in `dir`, or null: also for an ended session's archived images. */
export function imageInDir(dir: string, name: string): { file: string; type: string } | null {
  const m = NAME.exec(name);
  if (!m) return null;
  const file = join(dir, name);
  if (!existsSync(file) || !lstatSync(file).isFile()) return null;
  return { file, type: THREAD_IMAGE_TYPES[m[1] as ThreadImageExt] };
}

/** The host file behind a container path `/inbox/<sessionId>/<name>` staged for this session; null otherwise. */
export function threadImageFile(root: string, sessionId: string, containerPath: string): string | null {
  const prefix = `/inbox/${sessionId}/`;
  if (!containerPath.startsWith(prefix)) return null;
  return threadImageByName(root, sessionId, containerPath.slice(prefix.length))?.file ?? null;
}

/** The session's own images dir, or null when there is none. Throws for an id that could name another path. */
function ownImagesDir(root: string, sessionId: string): string | null {
  if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(sessionId) || sessionId === "." || sessionId === "..") throw new Error(`not a session id: ${sessionId}`);
  const dir = sessionDir(root, sessionId);
  let st: Stats;
  try { st = lstatSync(dir); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
  // `_inbox` is shared: a file or a symlink of that name is someone's upload, not this session's images.
  return st.isDirectory() ? dir : null;
}

/** Deletes the session's chat images (S5-R23); sessions.ts calls it once the container is gone and the thread archived. */
export function removeThreadImages(root: string, sessionId: string): void {
  const dir = ownImagesDir(root, sessionId);
  if (dir !== null) rmSync(dir, { recursive: true, force: true });
}

/** Moves the session's chat images to `<archiveDir>/images`, next to its archived transcript (endedSessions.ts). One
 *  rename on the same filesystem. Returns whether there were images to move; a failed move throws. */
export function archiveThreadImages(root: string, sessionId: string, archiveDir: string): boolean {
  const dir = ownImagesDir(root, sessionId);
  if (dir === null) return false;
  renameSync(dir, join(archiveDir, "images"));
  return true;
}
