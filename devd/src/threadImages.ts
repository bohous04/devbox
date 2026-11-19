import { existsSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Images a chat message may carry, by the extension they are stored under, with their media type. */
export const THREAD_IMAGE_TYPES = { png: "image/png", jpg: "image/jpeg", webp: "image/webp", gif: "image/gif" } as const;
export type ThreadImageExt = keyof typeof THREAD_IMAGE_TYPES;
export const THREAD_IMAGE_KINDS = "png, jpeg, webp or gif";

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

/** `<root>/_inbox/<sessionId>`: the session's own chat images, under `/inbox/<sessionId>` in every container. */
const sessionDir = (root: string, sessionId: string) => join(root, "_inbox", sessionId);

/** Stores a chat image as `<uuid>.<ext>` in the session's dir and returns its container path. Throws for a file that
 *  is not a png, jpeg, webp or gif. */
export function stageThreadImage(root: string, sessionId: string, bytes: Uint8Array): string {
  const ext = sniffImage(bytes);
  if (ext === null) throw new Error(`Only ${THREAD_IMAGE_KINDS} images can be attached`);
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
  const m = NAME.exec(name);
  if (!m) return null;
  const file = join(sessionDir(root, sessionId), name);
  if (!existsSync(file) || !lstatSync(file).isFile()) return null;
  return { file, type: THREAD_IMAGE_TYPES[m[1] as ThreadImageExt] };
}

/** The host file behind a container path `/inbox/<sessionId>/<name>` staged for this session; null otherwise. */
export function threadImageFile(root: string, sessionId: string, containerPath: string): string | null {
  const prefix = `/inbox/${sessionId}/`;
  if (!containerPath.startsWith(prefix)) return null;
  return threadImageByName(root, sessionId, containerPath.slice(prefix.length))?.file ?? null;
}
