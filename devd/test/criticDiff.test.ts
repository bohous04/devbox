import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sh } from "./helpers/sh";
import { collectTurnDiff, headSha, isEmptyTurnDiff, renderTurnDiff } from "../src/criticDiff";

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "critic-diff-"));
  sh(dir, "git", "init", "-q");
  sh(dir, "git", "config", "user.email", "t@t.cz");
  sh(dir, "git", "config", "user.name", "Test");
  writeFileSync(join(dir, "a.txt"), "original\n");
  sh(dir, "git", "add", "a.txt");
  sh(dir, "git", "commit", "-qm", "init");
  return dir;
}

test("headSha returns the SHA, and null for a repo without commits", async () => {
  const dir = repo();
  expect(await headSha(dir)).toMatch(/^[0-9a-f]{40}$/);
  const empty = mkdtempSync(join(tmpdir(), "critic-empty-"));
  sh(empty, "git", "init", "-q");
  expect(await headSha(empty)).toBeNull();
  rmSync(dir, { recursive: true, force: true });
  rmSync(empty, { recursive: true, force: true });
});

test("turn diff captures a working-tree change and a commit made during the turn", async () => {
  const dir = repo();
  const baseline = (await headSha(dir))!;
  writeFileSync(join(dir, "a.txt"), "changed\n");
  sh(dir, "git", "commit", "-qam", "agent work");
  writeFileSync(join(dir, "a.txt"), "changed and still in progress\n");
  const d = await collectTurnDiff(dir, baseline);
  expect(d.diff).toContain("-original");
  expect(d.diff).toContain("+changed and still in progress");
  expect(isEmptyTurnDiff(d)).toBe(false);
  rmSync(dir, { recursive: true, force: true });
});

test("new (untracked) files are attached with their content", async () => {
  const dir = repo();
  const baseline = (await headSha(dir))!;
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "new.ts"), "export const x = 1;\n");
  const d = await collectTurnDiff(dir, baseline);
  expect(d.newFiles).toHaveLength(1);
  expect(d.newFiles[0].path).toBe("src/new.ts");
  expect(d.newFiles[0].content).toContain("export const x = 1;");
  expect(renderTurnDiff(d)).toContain("src/new.ts");
  rmSync(dir, { recursive: true, force: true });
});

test("a large new file is not attached, only listed among the truncated ones", async () => {
  const dir = repo();
  const baseline = (await headSha(dir))!;
  writeFileSync(join(dir, "large.bin"), "x".repeat(5000));
  const d = await collectTurnDiff(dir, baseline, { perFile: 1000, total: 10_000 });
  expect(d.newFiles).toHaveLength(0);
  expect(d.truncated).toEqual(["large.bin"]);
  expect(renderTurnDiff(d)).toContain("large.bin");
  rmSync(dir, { recursive: true, force: true });
});

test("no changes = empty turn", async () => {
  const dir = repo();
  const d = await collectTurnDiff(dir, await headSha(dir));
  expect(isEmptyTurnDiff(d)).toBe(true);
  rmSync(dir, { recursive: true, force: true });
});

test("without a baseline (new repo without commits) the diff does not crash", async () => {
  const dir = mkdtempSync(join(tmpdir(), "critic-nocommit-"));
  sh(dir, "git", "init", "-q");
  writeFileSync(join(dir, "a.txt"), "new content\n");
  const d = await collectTurnDiff(dir, null);
  expect(d.newFiles.map((f) => f.path)).toContain("a.txt");
  rmSync(dir, { recursive: true, force: true });
});

test("a binary untracked file (NUL byte) goes to truncated, not to newFiles", async () => {
  const dir = repo();
  const baseline = (await headSha(dir))!;
  writeFileSync(join(dir, "bin.dat"), Buffer.from([0x41, 0x00, 0x42]));
  const d = await collectTurnDiff(dir, baseline);
  expect(d.newFiles.map((f) => f.path)).not.toContain("bin.dat");
  expect(d.truncated).toContain("bin.dat");
  expect(renderTurnDiff(d)).toMatch(/binary or too large/i);
  expect(renderTurnDiff(d)).toContain("bin.dat");
  rmSync(dir, { recursive: true, force: true });
});

test("nonexistent baseline SHA → collectTurnDiff throws instead of a silent 'empty diff'", async () => {
  const dir = repo();
  await expect(collectTurnDiff(dir, "0".repeat(40))).rejects.toThrow();
  rmSync(dir, { recursive: true, force: true });
});

test("an untracked file with diacritics in its name is found in newFiles", async () => {
  const dir = repo();
  const baseline = (await headSha(dir))!;
  writeFileSync(join(dir, "café-naïve.txt"), "crème brûlée\n");
  const d = await collectTurnDiff(dir, baseline);
  expect(d.newFiles.map((f) => f.path)).toContain("café-naïve.txt");
  rmSync(dir, { recursive: true, force: true });
});
