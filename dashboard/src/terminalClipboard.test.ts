import { test, expect } from "bun:test";
import { readBrowserClipboard, validateFiles, MAX_UPLOAD_BYTES, decodeOsc52, isPasteShortcut } from "./terminalClipboard";

test("browser clipboard prefers a screenshot over its text representation", async () => {
  const clip = { read: async () => [{ types: ["text/plain", "image/png"], getType: async (type: string) => new Blob([type === "image/png" ? "image" : "caption"], { type }) }] };
  const result = await readBrowserClipboard(clip as unknown as Clipboard);
  expect(result.files.length).toBe(1);
  expect(result.files[0]!.type).toBe("image/png");
  expect(await result.files[0]!.text()).toBe("image");
  expect(result.text).toBe("");
});

test("text clipboard works even in browsers without Clipboard.read", async () => {
  const result = await readBrowserClipboard({ readText: async () => "one\ntwo" } as Clipboard);
  expect(result).toEqual({ files: [], text: "one\ntwo" });
});

test("file upload validation rejects oversized, empty, and excessive files", () => {
  expect(() => validateFiles([new File([new Uint8Array(MAX_UPLOAD_BYTES + 1)], "too-big")])).toThrow("25 MB");
  expect(() => validateFiles([new File([], "empty")])).toThrow("empty");
  expect(() => validateFiles(Array.from({ length: 21 }, () => new File(["x"], "x")))).toThrow("20 files");
});

test("OSC 52 only accepts bounded UTF-8 text; clipboard reads and malformed payloads are ignored", () => {
  expect(decodeOsc52(`c;${btoa("hello")}`)).toBe("hello");
  for (const value of ["c;?", "c;", "c;%bad", "c;/w==", "c;" + "A".repeat(1_400_001)]) expect(decodeOsc52(value)).toBeNull();
});
test("Windows Ctrl+V and macOS Cmd+V bypass xterm's control-character handling", () => {
  const key = { type: "keydown", key: "v", ctrlKey: true, altKey: false, metaKey: false };
  expect(isPasteShortcut(key)).toBe(true);
  expect(isPasteShortcut({ ...key, ctrlKey: false, metaKey: true })).toBe(true);
  expect(isPasteShortcut({ ...key, altKey: true })).toBe(false);
  expect(isPasteShortcut({ ...key, key: "c" })).toBe(false);
});
