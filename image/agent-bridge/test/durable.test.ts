import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { replaceFileDurably, writeAll } from "../src/durable";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "durable-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("a failed write leaves the old file and no temp file behind", () => {
  const p = join(dir, "f.json");
  writeFileSync(p, "old");
  expect(() => replaceFileDurably(p, (fd) => {
    writeAll(fd, "partial");
    throw new Error("disk full");
  })).toThrow("disk full");
  expect(readFileSync(p, "utf8")).toBe("old");
  expect(existsSync(`${p}.tmp`)).toBe(false);
});
