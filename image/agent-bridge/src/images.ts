import { readFileSync } from "node:fs";
import { extname } from "node:path";

/** Images a chat message may carry (devd's upload only stores these); files under `/inbox` in the container. */
const MEDIA_TYPES: Record<string, "image/png" | "image/jpeg" | "image/webp" | "image/gif"> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

export function imageMediaType(path: string): "image/png" | "image/jpeg" | "image/webp" | "image/gif" {
  const type = MEDIA_TYPES[extname(path).toLowerCase()];
  if (type === undefined) throw new Error(`not a supported image: ${path}`);
  return type;
}

/** The file's bytes as base64 for harnesses that take inline images (Claude, ACP). Throws when it cannot be read. */
export function readImageBase64(path: string): { mediaType: ReturnType<typeof imageMediaType>; data: string } {
  const mediaType = imageMediaType(path);
  return { mediaType, data: readFileSync(path).toString("base64") };
}

/** A harness without image input gets the paths in its text, so the agent can still open the files. */
export function withImagePaths(text: string, paths: string[]): string {
  return `${text}\n\nAttached images (open the files at these paths):\n${paths.join("\n")}`;
}
