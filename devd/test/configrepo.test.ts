import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, saveConfig } from "../src/config";
import { createConfigRepo } from "../src/configrepo";

// `git diff --cached --quiet` exits 1 when there IS staged content (differs from
// HEAD) and 0 when there's nothing staged — the opposite of a typical "success" exit
// code, so these fakes return code:1 for "diff" to simulate real staged changes.
test("write persists sorted json and runs git add/diff/commit/push", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cfgrepo-"));
  saveConfig(join(dir, "config.json"), DEFAULT_CONFIG);
  const calls: string[][] = [];
  const repo = createConfigRepo(dir, (_cwd, ...cmd) => {
    calls.push(cmd);
    return { code: cmd[1] === "diff" ? 1 : 0, stdout: "", stderr: "" };
  });
  const cfg = repo.read();
  cfg.settings.autoStopHours = 8;
  await repo.write(cfg);
  expect(JSON.parse(readFileSync(join(dir, "config.json"), "utf8")).settings.autoStopHours).toBe(8);
  expect(calls.map((c) => c[1])).toEqual(["add", "diff", "commit", "push"]);
});

test("write throws when push fails but file is already committed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cfgrepo-"));
  saveConfig(join(dir, "config.json"), DEFAULT_CONFIG);
  const repo = createConfigRepo(dir, (_cwd, ...cmd) => {
    if (cmd[1] === "push") return { code: 1, stdout: "", stderr: "no remote" };
    if (cmd[1] === "diff") return { code: 1, stdout: "", stderr: "" }; // staged changes present
    return { code: 0, stdout: "", stderr: "" };
  });
  await expect(repo.write(repo.read())).rejects.toThrow(/push failed/);
  expect(readFileSync(join(dir, "config.json"), "utf8")).toContain("settings"); // file still written
});

test("write throws on a real commit failure and never pushes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cfgrepo-"));
  saveConfig(join(dir, "config.json"), DEFAULT_CONFIG);
  const calls: string[][] = [];
  const repo = createConfigRepo(dir, (_cwd, ...cmd) => {
    calls.push(cmd);
    if (cmd[1] === "commit") return { code: 1, stdout: "", stderr: "Author identity unknown" };
    if (cmd[1] === "diff") return { code: 1, stdout: "", stderr: "" }; // staged changes present
    return { code: 0, stdout: "", stderr: "" };
  });
  await expect(repo.write(repo.read())).rejects.toThrow(/commit failed/);
  expect(calls.map((c) => c[1])).toEqual(["add", "diff", "commit"]); // push never attempted
});

test("write skips commit and push entirely when nothing is staged", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cfgrepo-"));
  saveConfig(join(dir, "config.json"), DEFAULT_CONFIG);
  const calls: string[][] = [];
  const repo = createConfigRepo(dir, (_cwd, ...cmd) => {
    calls.push(cmd);
    return { code: cmd[1] === "diff" ? 0 : 0, stdout: "", stderr: "" }; // diff --cached --quiet: 0 = nothing staged
  });
  await expect(repo.write(repo.read())).resolves.toBeUndefined();
  expect(calls.map((c) => c[1])).toEqual(["add", "diff"]); // commit and push never attempted
});

test("write: two concurrent writes run one after another, not interleaved", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cfgrepo-"));
  writeFileSync(join(dir, "config.json"), JSON.stringify(DEFAULT_CONFIG));
  const order: string[] = [];
  const repo = createConfigRepo(dir, async (_cwd, ...cmd) => {
    order.push(cmd.slice(0, 2).join(" "));
    await new Promise((r) => setTimeout(r, 10));
    return { code: cmd[1] === "diff" ? 1 : 0, stdout: "", stderr: "" };
  });
  await Promise.all([repo.write(DEFAULT_CONFIG), repo.write(DEFAULT_CONFIG)]);
  // add, diff, commit, push — and only then the second add
  expect(order.slice(0, 5)).toEqual(["git add", "git diff", "git commit", "git push", "git add"]);
});
