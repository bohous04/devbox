import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cloneRepo, conflictPrompt, defaultBranch, giteaAuthEnv, pullWithRebase, sh as shAsync } from "../src/git";
import { sh } from "./helpers/sh";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "devd-git-"));
  const bare = join(root, "origin.git");
  sh(root, "git", "init", "--bare", bare);
  const a = join(root, "a");
  sh(root, "git", "clone", bare, a);
  sh(a, "git", "config", "user.email", "t@t"); sh(a, "git", "config", "user.name", "t");
  writeFileSync(join(a, "file.txt"), "base\n");
  sh(a, "git", "add", "."); sh(a, "git", "commit", "-m", "base"); sh(a, "git", "push");
  return { root, bare, a };
}

test("cloneRepo + clean pull", async () => {
  const { root, bare } = fixture();
  const b = join(root, "b");
  await cloneRepo(bare, b);
  sh(b, "git", "config", "user.email", "t@t"); sh(b, "git", "config", "user.name", "t");
  expect((await pullWithRebase(b)).status).toBe("clean");
});

test("conflicting pull reports conflicted files", async () => {
  const { root, bare, a } = fixture();
  const b = join(root, "b");
  await cloneRepo(bare, b);
  sh(b, "git", "config", "user.email", "t@t"); sh(b, "git", "config", "user.name", "t");
  writeFileSync(join(a, "file.txt"), "remote\n");
  sh(a, "git", "commit", "-am", "remote change"); sh(a, "git", "push");
  writeFileSync(join(b, "file.txt"), "local\n");
  sh(b, "git", "commit", "-am", "local change");
  const r = await pullWithRebase(b);
  expect(r.status).toBe("conflict");
  if (r.status === "conflict") expect(r.files).toEqual(["file.txt"]);
});

test("conflictPrompt is English and lists files", () => {
  const p = conflictPrompt(["a.ts", "b.ts"]);
  expect(p).toContain("A git pull resulted in a conflict");
  expect(p).toContain("a.ts, b.ts");
});

test("giteaAuthEnv builds host-scoped extraHeader env (Basic devbox:token)", () => {
  const env = giteaAuthEnv("http://198.51.100.7:3000/bob/game_main.git", "tok123");
  const b64 = Buffer.from("devbox:tok123").toString("base64");
  // Host-scoped so the header never leaks to a redirect target on another host;
  // GIT_CONFIG_* (not `-c`) so the token stays out of the process argv.
  expect(env).toEqual({
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.http://198.51.100.7:3000/.extraHeader",
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${b64}`,
  });
});

test("giteaAuthEnv is a no-op without a usable token", () => {
  expect(giteaAuthEnv("http://x:3000/o/r.git", undefined)).toEqual({});
  expect(giteaAuthEnv("http://x:3000/o/r.git", "")).toEqual({});
});

test("giteaAuthEnv is a no-op for an unparseable url", () => {
  expect(giteaAuthEnv("not a url", "tok")).toEqual({});
});

test("git.sh: asynchronous, timeout → code 124 with a message (an error, not a state)", async () => {
  process.env.DEVD_TIMEOUT_LOCAL_MS = "200";
  try {
    const order: string[] = [];
    const timer = new Promise<void>((r) => setTimeout(() => { order.push("timer"); r(); }, 50));
    const p = shAsync(process.cwd(), "sleep", "5").then((r) => { order.push("sh"); return r; });
    const [, r] = await Promise.all([timer, p]);
    expect(order).toEqual(["timer", "sh"]);
    expect(r.code).toBe(124);
    expect(r.stderr).toMatch(/timed out/);
  } finally { delete process.env.DEVD_TIMEOUT_LOCAL_MS; }
});

test("git.sh: the timeout message redacts userinfo from a URL in argv (I1)", async () => {
  // A clone URL can carry a token (`https://user:tok@host/…`) — the timeout message
  // used to build its text from the raw `cmd.join(" ")`, which is stored in the clone job in the DB
  // (gitClone → results[].error) that the dashboard shows. Here argv carries the URL
  // on purpose as an extra positional argument after `sh -c "sleep 5"` (it does not affect
  // the sleep), so the test goes through the real path via shWith/timeout, not just
  // redactArgv itself.
  process.env.DEVD_TIMEOUT_LOCAL_MS = "200";
  try {
    const r = await shAsync(process.cwd(), "sh", "-c", "sleep 5", "https://devbox:supersecret@host/x");
    expect(r.code).toBe(124);
    expect(r.stderr).toContain("***@host");
    expect(r.stderr).not.toContain("supersecret");
  } finally { delete process.env.DEVD_TIMEOUT_LOCAL_MS; }
});

test("defaultBranch is asynchronous", async () => {
  const bare = mkdtempSync(join(tmpdir(), "bare-"));
  sh(bare, "git", "init", "--bare", "-b", "trunk", bare);
  expect(await defaultBranch(bare)).toBe("trunk");
});
