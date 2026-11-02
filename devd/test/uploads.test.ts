import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_UPLOAD_BYTES, readUpload } from "../src/uploads";
import { stageShared } from "../src/inbox";

test("chunked uploads cannot bypass the size limit and the stream is cancelled", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(MAX_UPLOAD_BYTES)); controller.enqueue(new Uint8Array(1)); },
    cancel() { cancelled = true; },
  });
  await expect(readUpload(new Request("http://localhost", { method: "POST", body: stream }))).rejects.toThrow("25 MB");
  expect(cancelled).toBe(true);
});

test("empty uploads fail, ordinary binary bytes survive", async () => {
  await expect(readUpload(new Request("http://localhost", { method: "POST" }))).rejects.toThrow("empty");
  const bytes = new Uint8Array([0, 255, 128, 4]);
  expect(await readUpload(new Request("http://localhost", { method: "POST", body: bytes }))).toEqual(bytes);
});

test("shared uploads refuse a symlink inbox and do not follow a pre-existing destination symlink", () => {
  const root = mkdtempSync(join(tmpdir(), "upload-inbox-"));
  const dir = join(root, "inbox");
  const outside = join(root, "outside");
  mkdirSync(outside);
  symlinkSync(outside, dir, "dir");
  expect(() => stageShared(dir, "x.png", new Uint8Array([1]))).toThrow("symlink");
  const safe = join(root, "safe"); mkdirSync(safe);
  symlinkSync(join(outside, "target"), join(safe, "x.png"));
  // A dangling symlink is not overwritten (existsSync follows it, but wx refuses it).
  expect(() => stageShared(safe, "x.png", new Uint8Array([1]))).toThrow();
});
