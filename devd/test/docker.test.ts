import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { containerState, criticExecArgv, execInContainer, removeContainer, runContainer, spawnWithTimeout, startContainer, stopContainer } from "../src/docker";
import { sh } from "./helpers/sh";
import { hasDocker, RUN_ID, testPortBase } from "./helpers/docker";

// Unique name and ports per run — a concurrent run (another worktree) would otherwise delete the container.
const NAME = `devd-test-alpine-${RUN_ID}`;
const PORT = testPortBase();

// A fake `docker` on PATH: inspect hangs longer than the timeout. After the timeout
// containerState MUST throw — "missing" would mean recreating a healthy container.
function fakeDockerOnPath(script: string): () => void {
  const dir = mkdtempSync(join(tmpdir(), "fake-docker-"));
  writeFileSync(join(dir, "docker"), `#!/usr/bin/env bash\n${script}\n`);
  chmodSync(join(dir, "docker"), 0o755);
  const orig = process.env.PATH;
  process.env.PATH = `${dir}:${orig}`;
  return () => { process.env.PATH = orig; };
}

test("containerState: a docker timeout throws, does not return missing", async () => {
  const restore = fakeDockerOnPath('case "$1" in inspect) sleep 5 ;; esac; exit 0');
  process.env.DEVD_TIMEOUT_DOCKER_QUERY_MS = "200";
  try {
    await expect(containerState("anything")).rejects.toThrow(/timed out/);
  } finally { restore(); delete process.env.DEVD_TIMEOUT_DOCKER_QUERY_MS; }
});

test("execInContainer: returns RunResult with timedOut", async () => {
  const restore = fakeDockerOnPath('case "$1" in exec) sleep 5 ;; esac; exit 0');
  process.env.DEVD_TIMEOUT_DOCKER_QUERY_MS = "200";
  try {
    const r = await execInContainer("anything", ["true"]);
    expect(r.timedOut).toBe(true);
  } finally { restore(); delete process.env.DEVD_TIMEOUT_DOCKER_QUERY_MS; }
});

test.skipIf(!hasDocker)("container lifecycle with alpine", async () => {
  expect(await containerState(NAME)).toBe("missing");
  try {
    await runContainer({
      name: NAME, image: "alpine:3", workspace: mkdtempSync(join(tmpdir(), "ws-")),
      portBase: PORT, portsPerSession: 2, extraMounts: [], cmd: ["sleep", "infinity"],
    });
    expect(await containerState(NAME)).toBe("running");
    const r = await execInContainer(NAME, ["ls", "/workspace"]);
    expect(r.code).toBe(0);
    const portOut = sh(process.cwd(), "docker", "port", NAME);
    expect(portOut.stdout).toContain(`127.0.0.1:${PORT}`);
    await stopContainer(NAME);
    expect(await containerState(NAME)).toBe("exited");
    await startContainer(NAME);
    expect(await containerState(NAME)).toBe("running");
    await removeContainer(NAME);
    expect(await containerState(NAME)).toBe("missing");
  } finally { await removeContainer(NAME); }
}, 120_000);

test("spawnWithTimeout without input still works (stdin ignore)", async () => {
  const r = await spawnWithTimeout(["echo", "hi"], 5000);
  expect(r.code).toBe(0);
  expect(r.stdout.trim()).toBe("hi");
});

test("spawnWithTimeout with input sends the text via stdin", async () => {
  const r = await spawnWithTimeout(["cat"], 5000, "hello stdin");
  expect(r.code).toBe(0);
  expect(r.stdout).toContain("hello stdin");
});

test("criticExecArgv empties DEVD_SESSION_ID so the critic does not recurse via the Stop hook", () => {
  const args = criticExecArgv("devd-sess-1", ["claude", "-p"], false);
  expect(args).toEqual(["docker", "exec", "-e", "DEVD_SESSION_ID=", "devd-sess-1", "claude", "-p"]);
  const idx = args.indexOf("-e");
  expect(idx).toBeGreaterThan(-1);
  expect(args[idx + 1]).toBe("DEVD_SESSION_ID=");
  expect(args.indexOf("devd-sess-1")).toBeGreaterThan(idx + 1);
});

test("criticExecArgv with input adds -i and keeps -e DEVD_SESSION_ID= and the name+cmd order", () => {
  const args = criticExecArgv("devd-sess-2", ["claude", "-p", "--output-format", "json"], true);
  expect(args).toEqual([
    "docker", "exec", "-i", "-e", "DEVD_SESSION_ID=", "devd-sess-2",
    "claude", "-p", "--output-format", "json",
  ]);
  expect(args).toContain("-i");
  const nameIdx = args.indexOf("devd-sess-2");
  expect(args.slice(nameIdx)).toEqual(["devd-sess-2", "claude", "-p", "--output-format", "json"]);
});
