import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sanitizeName, uniquePath, ensureInbox, stageFile, stageShared } from "../src/inbox";

test("stageShared: writes to the shared dir, returns the /inbox path; collision → suffix; creates the dir; invalid throws", () => {
  const shared = join(mkdtempSync(join(tmpdir(), "shared-inbox-")), "_inbox"); // does not exist yet
  const p1 = stageShared(shared, "data.bin", new Uint8Array([1, 2, 3]));
  expect(p1).toBe("/inbox/data.bin");
  expect(existsSync(shared)).toBe(true);
  expect(readFileSync(join(shared, "data.bin"))).toEqual(Buffer.from([1, 2, 3]));
  expect(stageShared(shared, "data.bin", new Uint8Array([9]))).toBe("/inbox/data-1.bin");
  expect(() => stageShared(shared, "..", new Uint8Array([1]))).toThrow();
});

test("sanitizeName: basename, safe characters, rejects traversal and empty", () => {
  expect(sanitizeName("a/b/../c.pdf")).toBe("c.pdf");
  expect(sanitizeName("über name!.txt")).toBe("_ber_name_.txt");
  expect(sanitizeName("...")).toBeNull();
  expect(sanitizeName("")).toBeNull();
});

test("uniquePath: a collision gets a suffix before the extension", () => {
  const seen = new Set(["/d/x.pdf", "/d/x-1.pdf"]);
  const exists = (p: string) => seen.has(p);
  expect(uniquePath("/d", "new.pdf", exists)).toBe("/d/new.pdf");
  expect(uniquePath("/d", "x.pdf", exists)).toBe("/d/x-2.pdf");
});

test("ensureInbox: creates .inbox and adds to .git/info/exclude only when it is a repo", () => {
  const ws = mkdtempSync(join(tmpdir(), "inbox-ws-"));
  mkdirSync(join(ws, ".git", "info"), { recursive: true });
  const dir = ensureInbox(ws);
  expect(existsSync(dir)).toBe(true);
  expect(readFileSync(join(ws, ".git", "info", "exclude"), "utf8")).toContain(".inbox/");
  ensureInbox(ws); // idempotent — does not add a second time
  const lines = readFileSync(join(ws, ".git", "info", "exclude"), "utf8").split("\n").filter((l) => l === ".inbox/");
  expect(lines.length).toBe(1);
});

test("stageFile: writes the bytes and returns the container path; collision → suffix", () => {
  const ws = mkdtempSync(join(tmpdir(), "inbox-ws2-"));
  const p1 = stageFile(ws, "data.bin", new Uint8Array([1, 2, 3]));
  expect(p1).toBe("/workspace/.inbox/data.bin");
  expect(readFileSync(join(ws, ".inbox", "data.bin"))).toEqual(Buffer.from([1, 2, 3]));
  const p2 = stageFile(ws, "data.bin", new Uint8Array([9]));
  expect(p2).toBe("/workspace/.inbox/data-1.bin");
});

test("stageFile: an invalid name throws", () => {
  const ws = mkdtempSync(join(tmpdir(), "inbox-ws3-"));
  expect(() => stageFile(ws, "..", new Uint8Array([1]))).toThrow();
});

test("ensureInbox: without .git does not write .git/info/exclude", () => {
  const ws = mkdtempSync(join(tmpdir(), "inbox-nogit-"));
  // Workspace without .git — ensureInbox creates .inbox but must not create .git/info/exclude
  const dir = ensureInbox(ws);
  expect(existsSync(dir)).toBe(true);
  expect(existsSync(join(ws, ".git", "info", "exclude"))).toBe(false);
});
