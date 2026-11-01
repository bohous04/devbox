import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cloneBare, cloneProgressSink, parseProgressLine, type CloneProgress } from "../src/git";
import { run } from "../src/proc";
import { sh } from "./helpers/sh";

test("parseProgressLine reads the phase, percentage and detail", () => {
  expect(parseProgressLine("Receiving objects:  45% (90888/201972), 3.21 GiB | 30.12 MiB/s"))
    .toEqual({ phase: "Receiving objects", percent: 45, detail: "3.21 GiB | 30.12 MiB/s" });
  expect(parseProgressLine("Receiving objects: 100% (201972/201972), 8.50 GiB | 30.00 MiB/s, done."))
    .toEqual({ phase: "Receiving objects", percent: 100, detail: "8.50 GiB | 30.00 MiB/s" });
  expect(parseProgressLine("remote: Compressing objects:  12% (10/80)")).toEqual({ phase: "Compressing objects", percent: 12 });
  expect(parseProgressLine("Resolving deltas: 100% (5/5), done.")).toEqual({ phase: "Resolving deltas", percent: 100 });
  expect(parseProgressLine("Cloning into bare repository 'x.git'...")).toBeNull();
  expect(parseProgressLine("fatal: repository not found")).toBeNull();
});

test("cloneProgressSink joins lines split across chunks and reports the last one", () => {
  const seen: CloneProgress[] = [];
  const sink = cloneProgressSink((p) => seen.push(p));
  sink("Receiving objects:  1% (1/100)\rReceiving obj");
  sink("ects:  2% (2/100), 1.00 MiB | 1.00 MiB/s\r");
  sink("Resolving del");
  expect(seen).toEqual([
    { phase: "Receiving objects", percent: 1 },
    { phase: "Receiving objects", percent: 2, detail: "1.00 MiB | 1.00 MiB/s" },
  ]);
});

test("run() streams stderr to onStderr and an exception from it does not break reading", async () => {
  const chunks: string[] = [];
  const r = await run(["sh", "-c", "echo a >&2; echo b >&2"], {
    timeoutMs: 5_000,
    onStderr: (c) => { chunks.push(c); throw new Error("boom"); },
  });
  expect(r.code).toBe(0);
  expect(chunks.join("")).toBe("a\nb\n");
  expect(r.stderr).toBe("a\nb\n");
});

test("cloneBare reports progress and renames the finished clone from .partial", async () => {
  const root = mkdtempSync(join(tmpdir(), "devd-clonep-"));
  const origin = join(root, "origin.git");
  sh(root, "git", "init", "--bare", origin);
  const a = join(root, "a");
  sh(root, "git", "clone", origin, a);
  sh(a, "git", "config", "user.email", "t@t"); sh(a, "git", "config", "user.name", "t");
  writeFileSync(join(a, "f.txt"), "x\n");
  sh(a, "git", "add", "."); sh(a, "git", "commit", "-m", "x"); sh(a, "git", "push");
  const dest = join(root, "copy.git");
  const seen: CloneProgress[] = [];
  // file:// — a local path would go via hardlinks without a pack transfer, so without progress.
  await cloneBare(`file://${origin}`, dest, {}, (p) => seen.push(p));
  expect(existsSync(join(dest, "HEAD"))).toBe(true);
  expect(existsSync(`${dest}.partial`)).toBe(false);
  expect(seen.length).toBeGreaterThan(0);
});

test("a failed clone leaves neither dest nor .partial and the error has no progress lines", async () => {
  const root = mkdtempSync(join(tmpdir(), "devd-clonef-"));
  const dest = join(root, "nope.git");
  const err = await cloneBare(join(root, "missing.git"), dest, {}, () => {}).then(() => null, (e: Error) => e);
  expect(err?.message).toStartWith("git clone --bare failed: ");
  expect(err?.message).not.toContain("%");
  expect(existsSync(dest)).toBe(false);
  expect(existsSync(`${dest}.partial`)).toBe(false);
});
