import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { imageMediaType, readImageBase64, withImagePaths } from "../src/images";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

test("media types come from the extension: png, jpeg, webp, gif; anything else is refused", () => {
  expect(imageMediaType("/inbox/s/a.png")).toBe("image/png");
  expect(imageMediaType("/inbox/s/a.jpg")).toBe("image/jpeg");
  expect(imageMediaType("/inbox/s/a.JPEG")).toBe("image/jpeg");
  expect(imageMediaType("/inbox/s/a.webp")).toBe("image/webp");
  expect(imageMediaType("/inbox/s/a.gif")).toBe("image/gif");
  expect(() => imageMediaType("/inbox/s/a.svg")).toThrow("not a supported image");
  expect(() => imageMediaType("/inbox/s/noext")).toThrow("not a supported image");
});

test("readImageBase64 reads the file as base64 with its media type; a missing file throws", () => {
  const dir = mkdtempSync(join(tmpdir(), "images-"));
  dirs.push(dir);
  writeFileSync(join(dir, "a.png"), new Uint8Array([1, 2, 3]));
  expect(readImageBase64(join(dir, "a.png"))).toEqual({ mediaType: "image/png", data: "AQID" });
  expect(() => readImageBase64(join(dir, "gone.png"))).toThrow();
});

test("withImagePaths appends every path visibly, one per line", () => {
  expect(withImagePaths("look at these", ["/inbox/s/a.png", "/inbox/s/b.gif"]))
    .toBe("look at these\n\nAttached images (open the files at these paths):\n/inbox/s/a.png\n/inbox/s/b.gif");
});
