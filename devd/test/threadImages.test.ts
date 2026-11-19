import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sniffImage, stageThreadImage, threadImageFile } from "../src/threadImages";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "thread-images-")); dirs.push(d); return d; };

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2]);
const GIF = new TextEncoder().encode("GIF89a....");
const WEBP = new TextEncoder().encode("RIFF\x10\x00\x00\x00WEBPVP8 ");

test("sniffImage knows png, jpeg, webp and gif by their bytes; anything else is null", () => {
  expect(sniffImage(PNG)).toBe("png");
  expect(sniffImage(JPEG)).toBe("jpg");
  expect(sniffImage(GIF)).toBe("gif");
  expect(sniffImage(WEBP)).toBe("webp");
  expect(sniffImage(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
  expect(sniffImage(new TextEncoder().encode("RIFF\x10\x00\x00\x00WAVEfmt "))).toBeNull();
  expect(sniffImage(new Uint8Array([0x89, 0x50]))).toBeNull();
});

test("stageThreadImage writes <root>/_inbox/<session>/<uuid>.<ext> and returns its /inbox path", () => {
  const root = tmp();
  const path = stageThreadImage(root, "dev-a-chat", PNG);
  expect(path).toMatch(/^\/inbox\/dev-a-chat\/[0-9a-f-]{36}\.png$/);
  const name = path.split("/").pop()!;
  expect(readFileSync(join(root, "_inbox", "dev-a-chat", name))).toEqual(Buffer.from(PNG));
  expect(stageThreadImage(root, "dev-a-chat", GIF)).toMatch(/\.gif$/);
  expect(() => stageThreadImage(root, "dev-a-chat", new TextEncoder().encode("hello"))).toThrow("png, jpeg, webp or gif");
});

test("stageThreadImage refuses a session dir that is a symlink", () => {
  const root = tmp();
  mkdirSync(join(root, "_inbox"), { recursive: true });
  symlinkSync(tmp(), join(root, "_inbox", "dev-a-chat"));
  expect(() => stageThreadImage(root, "dev-a-chat", PNG)).toThrow("directory");
});

test("threadImageFile: only an existing image staged for this session; other sessions, traversal, other names → null", () => {
  const root = tmp();
  const path = stageThreadImage(root, "dev-a-chat", PNG);
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
