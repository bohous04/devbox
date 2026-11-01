import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  accountLoginStatus, cancelAccountLogin, codexAccountMountList, codexAccountVolume,
  CodexProfileInUseError, readAccountAuth, removeAccountProfile, startAccountLogin,
} from "../src/codexAccountProfiles";
import type { CodexAuthDeps } from "../src/agentAuth";

const DEVICE_LOG = "https://auth.openai.com/codex/device\nABCD-12345\n";
const SECRET = "fake-private-access-token-do-not-return";
const AUTH = JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: SECRET, account_id: "test-account" } });
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
type Result = { code: number; stdout: string; stderr: string };
const ok = (stdout = ""): Result => ({ code: 0, stdout, stderr: "" });
const fail = (stderr = SECRET): Result => ({ code: 1, stdout: "", stderr });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "codex-account-profile-test-"));
  roots.push(root);
  const containers = new Map<string, { volume: string; Status: string; ExitCode: number }>();
  const calls: string[][] = [];
  let hook: ((cmd: string[]) => Promise<Result | undefined> | Result | undefined) | undefined;
  let log = DEVICE_LOG;
  let sleeps = 0;
  const volumeDir = (volume: string) => join(root, volume);
  const seed = (id: string, auth?: string) => {
    const volume = codexAccountVolume(id);
    mkdirSync(volumeDir(volume), { recursive: true });
    if (auth !== undefined) writeFileSync(join(volumeDir(volume), "auth.json"), auth);
  };
  const run: CodexAuthDeps["run"] = async cmd => {
    calls.push(cmd);
    const custom = await hook?.(cmd);
    if (custom) return custom;
    if (cmd[0] === "volume") {
      if (cmd[1] === "ls") return ok(readdirSync(root).join("\n"));
      if (cmd[1] === "create") { mkdirSync(volumeDir(cmd[2]), { recursive: true }); return ok(cmd[2]); }
      if (cmd[1] === "rm") { rmSync(volumeDir(cmd[2]), { recursive: true }); return ok(); }
    }
    if (cmd[0] === "ps") {
      const filter = cmd[cmd.indexOf("--filter") + 1];
      if (filter.startsWith("volume=")) return ok([...containers].filter(([, c]) => c.volume === filter.slice(7)).map(([name]) => name).join("\n"));
      const name = filter.slice("name=^/".length, -1);
      return ok(containers.has(name) ? name : "");
    }
    if (cmd[0] === "rm") { containers.delete(cmd.at(-1)!); return ok(); }
    if (cmd[0] === "logs") return ok(log);
    if (cmd[0] === "inspect") {
      const state = containers.get(cmd.at(-1)!);
      return state ? ok(JSON.stringify(state)) : fail("No such container");
    }
    if (cmd[0] === "run") {
      const mount = cmd.includes("--mount") ? cmd[cmd.indexOf("--mount") + 1] : cmd[cmd.indexOf("-v") + 1];
      const volume = mount.startsWith("type=") ? mount.match(/source=([^,]+)/)![1] : mount.split(":")[0];
      if (cmd.includes("-d")) {
        const name = cmd[cmd.indexOf("--name") + 1];
        containers.set(name, { volume, Status: "running", ExitCode: 0 });
        return ok("fake-container-id");
      }
      if (cmd.includes("sh")) return readdirSync(volumeDir(volume)).length === 0 ? ok() : fail();
      if (cmd.includes("cat")) {
        try { return ok(readFileSync(join(volumeDir(volume), "auth.json"), "utf8")); }
        catch { return fail("No such file"); }
      }
      if (cmd.includes("status")) return ok("Logged in using ChatGPT");
    }
    throw new Error(`Unexpected fake Docker command: ${cmd.join(" ")}`);
  };
  const deps: CodexAuthDeps = { run, sleep: async () => { sleeps++; }, image: "test-devbox" };
  return {
    deps, calls, containers, seed, volumeDir,
    setHook: (value: typeof hook) => { hook = value; },
    setLog: (value: string) => { log = value; },
    getSleeps: () => sleeps,
    finish: (id: string, exitCode = 0) => {
      containers.set(`devbox-codex-login-${id}`, { volume: codexAccountVolume(id), Status: "exited", ExitCode: exitCode });
    },
  };
}

test("volume and mount IDs are bounded, deduplicated, and keep default on codex-home", () => {
  expect(codexAccountVolume("default")).toBe("codex-home");
  expect(codexAccountVolume("work-2")).toBe("codex-acct-work-2");
  expect(codexAccountVolume("a".repeat(64))).toBe(`codex-acct-${"a".repeat(64)}`);
  for (const id of ["", "../default", "X", "a:b", "a/b", "-one", "a".repeat(65)]) expect(() => codexAccountVolume(id)).toThrow("Invalid");
  expect(codexAccountMountList(["default", "work", "work", "../escape", "personal"]))
    .toEqual(["codex-acct-work:/home/dev/.codex-accounts/work", "codex-acct-personal:/home/dev/.codex-accounts/personal"]);
});

test("default and invalid IDs never invoke Docker mutations", async () => {
  const f = fixture();
  for (const id of ["default", "../../codex-home"]) {
    await expect(startAccountLogin(f.deps, id)).rejects.toThrow();
    await expect(cancelAccountLogin(f.deps, id)).rejects.toThrow();
    await expect(removeAccountProfile(f.deps, id)).rejects.toThrow();
  }
  expect(f.calls).toHaveLength(0);
});

test("new login uses isolated empty volume, named process, and file credential store", async () => {
  const f = fixture();
  expect(await startAccountLogin(f.deps, "work")).toEqual({ url: "https://auth.openai.com/codex/device", code: "ABCD-12345", expiresInSec: 900 });
  const start = f.calls.find(cmd => cmd.includes("-d"))!;
  expect(start).toContain("devbox-codex-login-work");
  expect(start).toContain("type=volume,source=codex-acct-work,target=/home/dev/.codex,volume-nocopy");
  expect(start.slice(-5)).toEqual(["codex", "-c", 'cli_auth_credentials_store="file"', "login", "--device-auth"]);
  expect(JSON.stringify(f.calls)).not.toContain("codex-home");
  expect(f.calls.some(cmd => cmd.includes("0") && cmd.includes("sh"))).toBe(true);
});

test("overlapping starts for one ID are refused before any second login process", async () => {
  const f = fixture();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.setHook(async cmd => { if (cmd[0] === "volume" && cmd[1] === "ls") await gate; return undefined; });
  const first = startAccountLogin(f.deps, "work");
  await expect(startAccountLogin(f.deps, "work")).rejects.toThrow("has already been started");
  expect(await accountLoginStatus(f.deps, "work")).toBe("pending");
  release();
  await first;
  await expect(startAccountLogin(f.deps, "work")).rejects.toThrow("has already been started");
  expect(f.calls.filter(cmd => cmd.includes("-d"))).toHaveLength(1);
});

test("separate accounts can log in concurrently without sharing containers or volumes", async () => {
  const f = fixture();
  await Promise.all([startAccountLogin(f.deps, "work"), startAccountLogin(f.deps, "personal")]);
  expect([...f.containers.keys()].sort()).toEqual(["devbox-codex-login-personal", "devbox-codex-login-work"]);
  await cancelAccountLogin(f.deps, "work");
  expect(await accountLoginStatus(f.deps, "personal")).toBe("pending");
  expect(f.containers.has("devbox-codex-login-work")).toBe(false);
});

test("existing auth or even an existing empty volume is never overwritten by Add", async () => {
  for (const auth of [undefined, AUTH]) {
    const f = fixture();
    f.seed("existing", auth);
    await expect(startAccountLogin(f.deps, "existing")).rejects.toThrow("the profile may already exist");
    expect(f.calls.every(cmd => cmd[0] === "volume" && cmd[1] === "ls")).toBe(true);
    if (auth) expect(readFileSync(join(f.volumeDir("codex-acct-existing"), "auth.json"), "utf8")).toBe(AUTH);
  }
});

test("a signed-in stale profile without this login's exited process is not done", async () => {
  const f = fixture();
  f.seed("old", AUTH);
  expect(await accountLoginStatus(f.deps, "old")).toBe("error");
  expect(f.calls.some(cmd => cmd.includes("cat") || cmd.includes("status"))).toBe(false);
});

test("auth appearing while the actual login is still running stays pending", async () => {
  const f = fixture();
  await startAccountLogin(f.deps, "work");
  f.seed("work", AUTH);
  expect(await accountLoginStatus(f.deps, "work")).toBe("pending");
  expect(f.calls.some(cmd => cmd.includes("cat") || cmd.includes("status"))).toBe(false);
  expect(f.containers.has("devbox-codex-login-work")).toBe(true);
});

test("done requires exit zero, stored access token, and successful CLI login status", async () => {
  const f = fixture();
  await startAccountLogin(f.deps, "work");
  f.seed("work", AUTH);
  f.finish("work");
  expect(await accountLoginStatus(f.deps, "work")).toBe("done");
  expect(await accountLoginStatus(f.deps, "work")).toBe("done");
  expect(f.containers.size).toBe(0);
  expect(f.calls.find(cmd => cmd.includes("status"))).toContain('cli_auth_credentials_store="file"');
});

test("failed process does not succeed even with a valid credential file", async () => {
  const f = fixture();
  await startAccountLogin(f.deps, "work");
  f.seed("work", AUTH);
  f.finish("work", 1);
  expect(await accountLoginStatus(f.deps, "work")).toBe("error");
  expect(f.containers.size).toBe(0);
  expect(f.calls.some(cmd => cmd.includes("status"))).toBe(false);
});

test("missing, malformed, or empty-token auth and failing CLI status cannot complete login", async () => {
  for (const auth of [undefined, "not-json", "{}", '{"tokens":{"access_token":"   "}}', AUTH]) {
    const f = fixture();
    await startAccountLogin(f.deps, "work");
    f.seed("work", auth);
    f.finish("work");
    if (auth === AUTH) f.setHook(cmd => cmd.includes("status") ? { code: 1, stdout: "Logged in", stderr: SECRET } : undefined);
    expect(await accountLoginStatus(f.deps, "work")).toBe("error");
    expect(f.containers.size).toBe(0);
  }
});

test("device-code polling has a fixed bound and cleans up a failed login", async () => {
  const f = fixture();
  f.setLog(`Waiting ${SECRET}`);
  await expect(startAccountLogin(f.deps, "work")).rejects.toThrow("Could not start the GPT account login");
  expect(f.getSleeps()).toBe(15);
  expect(f.calls.filter(cmd => cmd[0] === "logs")).toHaveLength(15);
  expect(f.containers.size).toBe(0);
});

test("Docker launch failures and thrown secrets are sanitized and stopped", async () => {
  for (const throws of [false, true]) {
    const f = fixture();
    f.setHook(cmd => {
      if (cmd.includes("-d")) {
        f.containers.set("devbox-codex-login-work", { volume: "codex-acct-work", Status: "running", ExitCode: 0 });
        if (throws) throw new Error(SECRET);
        return fail();
      }
      return undefined;
    });
    try { await startAccountLogin(f.deps, "work"); throw new Error("expected failure"); }
    catch (error) { expect((error as Error).message).not.toContain(SECRET); }
    expect(f.containers.size).toBe(0);
    expect(f.calls.some(cmd => cmd[0] === "rm")).toBe(true);
  }
});

test("missing volume reads and deletes do not implicitly create a volume", async () => {
  const f = fixture();
  expect(await readAccountAuth(f.deps, "missing")).toEqual({ raw: null, dockerError: null });
  await removeAccountProfile(f.deps, "missing");
  expect(f.calls.every(cmd => cmd[0] === "volume" && cmd[1] === "ls")).toBe(true);
});

test("auth reads return internal blob while Docker failures return generic errors", async () => {
  const f = fixture();
  f.seed("work", AUTH);
  expect(await readAccountAuth(f.deps, "work")).toEqual({ raw: AUTH, dockerError: null });
  f.setHook(cmd => cmd.includes("cat") ? fail() : undefined);
  const result = await readAccountAuth(f.deps, "work");
  expect(result.raw).toBeNull();
  expect(result.dockerError).toContain("Could not read");
  expect(result.dockerError).not.toContain(SECRET);
});

test("default identity reads only mount the existing auth read-only without image copy-up", async () => {
  const f = fixture();
  f.seed("default", AUTH);
  expect(await readAccountAuth(f.deps, "default")).toEqual({ raw: AUTH, dockerError: null });
  expect(f.calls).toHaveLength(2);
  expect(f.calls[0]?.slice(0, 2)).toEqual(["volume", "ls"]);
  const read = f.calls[1]!;
  expect(read).toContain("codex-home:/home/dev/.codex:ro,nocopy");
  expect(read.slice(-2)).toEqual(["cat", "/home/dev/.codex/auth.json"]);
  expect(read).not.toContain("login");
  expect(read).not.toContain("-d");
  expect(readFileSync(join(f.volumeDir("codex-home"), "auth.json"), "utf8")).toBe(AUTH);
});

test("profile deletion refuses both running and stopped session references without erasing auth", async () => {
  for (const state of ["running", "exited"]) {
    const f = fixture();
    f.seed("work", AUTH);
    f.containers.set("devbox-session", { volume: "codex-acct-work", Status: state, ExitCode: 0 });
    await expect(removeAccountProfile(f.deps, "work")).rejects.toBeInstanceOf(CodexProfileInUseError);
    await expect(removeAccountProfile(f.deps, "work")).rejects.toThrow("This GPT account is mounted by a container.");
    expect(readFileSync(join(f.volumeDir("codex-acct-work"), "auth.json"), "utf8")).toBe(AUTH);
    expect(f.calls.some(cmd => cmd[0] === "run" || (cmd[0] === "volume" && cmd[1] === "rm"))).toBe(false);
  }
});

test("cancel preserves potential auth, explicit safe removal then permits retry", async () => {
  const f = fixture();
  await startAccountLogin(f.deps, "work");
  f.seed("work", AUTH);
  await cancelAccountLogin(f.deps, "work");
  expect(await readAccountAuth(f.deps, "work")).toEqual({ raw: AUTH, dockerError: null });
  await removeAccountProfile(f.deps, "work");
  expect(await readAccountAuth(f.deps, "work")).toEqual({ raw: null, dockerError: null });
  expect(await startAccountLogin(f.deps, "work")).toHaveProperty("code", "ABCD-12345");
});

test("daemon failures cannot be mistaken for missing profiles and do not leak stderr", async () => {
  const f = fixture();
  f.setHook(cmd => cmd[0] === "volume" && cmd[1] === "ls" ? fail() : undefined);
  const read = await readAccountAuth(f.deps, "work");
  expect(read.dockerError).toContain("Could not read");
  expect(read.dockerError).not.toContain(SECRET);
  await expect(removeAccountProfile(f.deps, "work")).rejects.toThrow("safely remove");
  expect(f.calls.every(cmd => cmd[0] === "volume" && cmd[1] === "ls")).toBe(true);
});
