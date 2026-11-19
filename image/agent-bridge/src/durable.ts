import { closeSync, fsyncSync, openSync, renameSync, writeSync } from "node:fs";
import { dirname } from "node:path";

/** Replaces `path` so that a crash or power loss leaves either the old or the new content, never a torn or empty
 *  file: write a temp file, fsync it, rename it over `path`, fsync the directory (the rename itself). */
export function replaceFileDurably(path: string, write: (fd: number) => void): void {
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, "w");
  try {
    write(fd);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  const dir = openSync(dirname(path), "r");
  try {
    fsyncSync(dir);
  } finally {
    closeSync(dir);
  }
}

export function writeAll(fd: number, data: string | Uint8Array): void {
  const buf = typeof data === "string" ? Buffer.from(data) : data;
  let off = 0;
  while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
}
