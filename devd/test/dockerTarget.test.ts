import { afterEach, expect, test } from "bun:test";
import { dockerArgv, ibxAlias, loadRemoteDockers, remoteDockerAlias, runDocker, setRemoteAuthRefresher, setRemoteDocker } from "../src/dockerTarget";
import { criticExecArgv } from "../src/docker";
import { insertSession, openDb } from "../src/db";
import type { RunResult } from "../src/proc";

afterEach(() => {
  for (const c of ["dev-a-b", "dev-a-c", "dev-a-d"]) setRemoteDocker(c, null);
  setRemoteAuthRefresher(null);
});

test("local container → docker", () => {
  expect(dockerArgv("dev-a-b")).toEqual(["docker"]);
  expect(dockerArgv()).toEqual(["docker"]);
});

test("remote container → docker -H ssh://alias", () => {
  setRemoteDocker("dev-a-b", ibxAlias("m_1"));
  expect(dockerArgv("dev-a-b")).toEqual(["docker", "-H", "ssh://ibx-m_1"]);
  expect(remoteDockerAlias("dev-a-b")).toBe("ibx-m_1");
  setRemoteDocker("dev-a-b", null);
  expect(dockerArgv("dev-a-b")).toEqual(["docker"]);
});

test("criticExecArgv respects the resolver", () => {
  setRemoteDocker("dev-a-b", "ibx-m_1");
  expect(criticExecArgv("dev-a-b", ["claude"], false)).toEqual(["docker", "-H", "ssh://ibx-m_1", "exec", "-e", "DEVD_SESSION_ID=", "dev-a-b", "claude"]);
});

test("loadRemoteDockers loads only running instabox sessions with a machine id", () => {
  const db = openDb(":memory:");
  const row = { folder: "f", project: "a", status: "running" as const, solo: 0 as const, created_at: 1, last_active_at: 1, important: 0 as const };
  insertSession(db, { ...row, id: "dev-a-b", repo: "b", container: "dev-a-b", port_base: 40100, host: "instabox", instabox_machine_id: "m_9" });
  insertSession(db, { ...row, id: "dev-a-c", repo: "c", container: "dev-a-c", port_base: 40110 });
  insertSession(db, { ...row, id: "dev-a-d", repo: "d", container: "dev-a-d", port_base: 40120, status: "stopped", host: "instabox", instabox_machine_id: "m_8" });
  loadRemoteDockers(db);
  expect(dockerArgv("dev-a-b")).toEqual(["docker", "-H", "ssh://ibx-m_9"]);
  expect(dockerArgv("dev-a-c")).toEqual(["docker"]);
  expect(dockerArgv("dev-a-d")).toEqual(["docker"]); // paused: SSH would wake the machine
});

test("runDocker: expired certificate → refresh and one retry", async () => {
  setRemoteDocker("dev-a-b", "ibx-m_1");
  const seen: string[][] = [];
  let refreshed = 0;
  setRemoteAuthRefresher(async (c) => { expect(c).toBe("dev-a-b"); refreshed++; });
  const exec = async (cmd: string[]): Promise<RunResult> => {
    seen.push(cmd);
    return seen.length === 1
      ? { code: 255, stdout: "", stderr: "user@api.instabox.sh: Permission denied (publickey).", timedOut: false }
      : { code: 0, stdout: "running\n", stderr: "", timedOut: false };
  };
  const r = await runDocker("dev-a-b", ["inspect", "dev-a-b"], { timeoutMs: 1000 }, exec);
  expect(r.code).toBe(0);
  expect(refreshed).toBe(1);
  expect(seen).toEqual([["docker", "-H", "ssh://ibx-m_1", "inspect", "dev-a-b"], ["docker", "-H", "ssh://ibx-m_1", "inspect", "dev-a-b"]]);
});

test("runDocker: a local error is not retried", async () => {
  let calls = 0;
  setRemoteAuthRefresher(async () => { throw new Error("must not be called"); });
  const exec = async (): Promise<RunResult> => { calls++; return { code: 1, stdout: "", stderr: "Permission denied (publickey)", timedOut: false }; };
  await runDocker("dev-a-c", ["ps"], { timeoutMs: 1000 }, exec);
  expect(calls).toBe(1);
});

test("runDocker: refresher fails → returns the first result, does not throw", async () => {
  setRemoteDocker("dev-a-b", "ibx-m_1");
  setRemoteAuthRefresher(async () => { throw new Error("api down"); });
  let calls = 0;
  const first: RunResult = { code: 255, stdout: "", stderr: "Permission denied (publickey).", timedOut: false };
  const exec = async (): Promise<RunResult> => { calls++; return first; };
  expect(await runDocker("dev-a-b", ["inspect", "dev-a-b"], { timeoutMs: 1000 }, exec)).toBe(first);
  expect(calls).toBe(1);
});
