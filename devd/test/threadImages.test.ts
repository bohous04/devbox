import { afterEach, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { imageSize, MAX_THREAD_IMAGE_BYTES, removeThreadImages, sniffImage, stageThreadImage, ThreadImageError, threadImageFile } from "../src/threadImages";
import { gif, jpeg, png, webp } from "./helpers/images";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "thread-images-")); dirs.push(d); return d; };
const enc = (s: string) => new TextEncoder().encode(s);

test("sniffImage knows png, jpeg, webp and gif by their bytes; anything else is null", () => {
  expect(sniffImage(png(1, 1))).toBe("png");
  expect(sniffImage(jpeg(1, 1))).toBe("jpg");
  expect(sniffImage(gif(1, 1))).toBe("gif");
  expect(sniffImage(webp(1, 1))).toBe("webp");
  expect(sniffImage(enc("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
  expect(sniffImage(enc("RIFF\x10\x00\x00\x00WAVEfmt "))).toBeNull();
  expect(sniffImage(new Uint8Array([0x89, 0x50]))).toBeNull();
});

test("imageSize reads width and height from each format's header; a truncated header is null", () => {
  expect(imageSize(png(640, 480), "png")).toEqual({ width: 640, height: 480 });
  expect(imageSize(jpeg(1024, 768), "jpg")).toEqual({ width: 1024, height: 768 });
  expect(imageSize(gif(320, 200), "gif")).toEqual({ width: 320, height: 200 });
  expect(imageSize(webp(9000, 10), "webp")).toEqual({ width: 9000, height: 10 });
  // Lossy (VP8 ) and lossless (VP8L) webp.
  const vp8 = new Uint8Array(30);
  vp8.set(enc("RIFF\0\0\0\0WEBPVP8 \0\0\0\0"));
  vp8.set([0, 0, 0, 0x9d, 0x01, 0x2a, 0x80, 0x02, 0xe0, 0x01], 20);
  expect(imageSize(vp8, "webp")).toEqual({ width: 640, height: 480 });
  const vp8l = new Uint8Array(25);
  vp8l.set(enc("RIFF\0\0\0\0WEBPVP8L\0\0\0\0"));
  // width-1 = 639 (14 bits), height-1 = 479 (14 bits), little-endian bit packing.
  const bits = 639 | (479 << 14);
  vp8l.set([0x2f, bits & 255, (bits >>> 8) & 255, (bits >>> 16) & 255, (bits >>> 24) & 255], 20);
  expect(imageSize(vp8l, "webp")).toEqual({ width: 640, height: 480 });
  expect(imageSize(png(1, 1).slice(0, 20), "png")).toBeNull();
  expect(imageSize(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0]), "jpg")).toBeNull();
});

test("stageThreadImage writes <root>/_inbox/<session>/<uuid>.<ext> and returns its /inbox path", () => {
  const root = tmp();
  const bytes = png(10, 10);
  const path = stageThreadImage(root, "dev-a-chat", bytes);
  expect(path).toMatch(/^\/inbox\/dev-a-chat\/[0-9a-f-]{36}\.png$/);
  const name = path.split("/").pop()!;
  expect(readFileSync(join(root, "_inbox", "dev-a-chat", name))).toEqual(Buffer.from(bytes));
  expect(stageThreadImage(root, "dev-a-chat", gif(5, 5))).toMatch(/\.gif$/);
});

test("stageThreadImage refuses other files 415 and images over 5 MB or 8000 px on a side 413", () => {
  const root = tmp();
  const refused = (bytes: Uint8Array) => {
    try { stageThreadImage(root, "dev-a-chat", bytes); } catch (e) { return e as ThreadImageError; }
    throw new Error("not refused");
  };
  const other = refused(enc("hello"));
  expect(other).toBeInstanceOf(ThreadImageError);
  expect([other.status, other.message]).toEqual([415, "Only png, jpeg, webp or gif images can be attached"]);
  expect(refused(png(1, 1).slice(0, 20))).toMatchObject({ status: 415, message: "The image's size could not be read" });
  const heavy = refused(jpeg(100, 100, MAX_THREAD_IMAGE_BYTES + 1));
  expect([heavy.status, heavy.message]).toEqual([413, "The image is 5.0 MB; chat images may be at most 5 MB"]);
  expect(refused(png(8001, 10))).toMatchObject({ status: 413, message: "The image is 8001×10 px; chat images may be at most 8000 px on a side" });
  expect(refused(gif(10, 8001)).status).toBe(413);
  expect(stageThreadImage(root, "dev-a-chat", png(8000, 8000, MAX_THREAD_IMAGE_BYTES))).toMatch(/\.png$/);
  expect(existsSync(join(root, "_inbox", "dev-a-chat"))).toBe(true);
});

test("stageThreadImage refuses a session dir that is a symlink", () => {
  const root = tmp();
  mkdirSync(join(root, "_inbox"), { recursive: true });
  symlinkSync(tmp(), join(root, "_inbox", "dev-a-chat"));
  expect(() => stageThreadImage(root, "dev-a-chat", png(1, 1))).toThrow("directory");
});

test("threadImageFile: only an existing image staged for this session; other sessions, traversal, other names → null", () => {
  const root = tmp();
  const path = stageThreadImage(root, "dev-a-chat", png(1, 1));
  const name = path.split("/").pop()!;
  expect(threadImageFile(root, "dev-a-chat", path)).toBe(join(root, "_inbox", "dev-a-chat", name));
  expect(threadImageFile(root, "dev-b-chat", path.replace("dev-a-chat", "dev-b-chat"))).toBeNull(); // not there
  expect(threadImageFile(root, "dev-b-chat", path)).toBeNull(); // another session's image
  expect(threadImageFile(root, "dev-a-chat", `/inbox/dev-a-chat/../dev-a-chat/${name}`)).toBeNull();
  expect(threadImageFile(root, "dev-a-chat", `/inbox/${name}`)).toBeNull();
  expect(threadImageFile(root, "dev-a-chat", "/inbox/dev-a-chat/00000000-0000-4000-8000-000000000000.png")).toBeNull(); // missing
  writeFileSync(join(root, "_inbox", "dev-a-chat", "notes.txt"), "x");
  expect(threadImageFile(root, "dev-a-chat", "/inbox/dev-a-chat/notes.txt")).toBeNull();
});

test("removeThreadImages deletes only the session's own dir; the shared inbox and other sessions stay", () => {
  const root = tmp();
  stageThreadImage(root, "dev-a-chat", png(1, 1));
  stageThreadImage(root, "dev-b-chat", png(1, 1));
  writeFileSync(join(root, "_inbox", "shared.png"), "x");
  removeThreadImages(root, "dev-a-chat");
  expect(existsSync(join(root, "_inbox", "dev-a-chat"))).toBe(false);
  expect(existsSync(join(root, "_inbox", "dev-b-chat"))).toBe(true);
  expect(existsSync(join(root, "_inbox", "shared.png"))).toBe(true);
  removeThreadImages(root, "dev-never-had-images");
  for (const bad of ["", ".", "..", "a/b"]) expect(() => removeThreadImages(root, bad)).toThrow("not a session id");
});

test("removeThreadImages leaves `_inbox/<id>` alone unless it is a directory (a shared file or a symlink of that name)", () => {
  const root = tmp();
  mkdirSync(join(root, "_inbox"), { recursive: true });
  writeFileSync(join(root, "_inbox", "dev-file"), "shared upload");
  removeThreadImages(root, "dev-file");
  expect(existsSync(join(root, "_inbox", "dev-file"))).toBe(true);
  const target = tmp();
  writeFileSync(join(target, "keep.png"), "x");
  symlinkSync(target, join(root, "_inbox", "dev-link"));
  removeThreadImages(root, "dev-link");
  expect(lstatSync(join(root, "_inbox", "dev-link")).isSymbolicLink()).toBe(true);
  expect(existsSync(join(target, "keep.png"))).toBe(true);
});
