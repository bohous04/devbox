import { expect, test } from "bun:test";
import { runArgs } from "../src/docker";

const base = { name: "dev-x-y", image: "devbox:latest", workspace: "/w", portBase: 40100, portsPerSession: 2 };

test("the container gets the sidecar network and keeps its published ports", () => {
  const a = runArgs({ ...base, network: "dind-net-dev-x-y", env: { DOCKER_HOST: "tcp://dind-dev-x-y:2375" } });
  expect(a.join(" ")).toContain("--network dind-net-dev-x-y");
  expect(a.join(" ")).toContain("-p 127.0.0.1:40100:3000");
  expect(a.join(" ")).toContain("DOCKER_HOST=tcp://dind-dev-x-y:2375");
});

test("without a network no empty argument is added", () => {
  expect(runArgs(base).join(" ")).not.toContain("--network");
});

test("the host socket is not mounted into the container", () => {
  const a = runArgs({ ...base, extraMounts: ["claude-home:/home/dev/.claude"] });
  expect(a.join(" ")).not.toContain("/var/run/docker.sock");
});

test("a session has a memory cap — one session must not eat the whole server", () => {
  const a = runArgs(base).join(" ");
  expect(a).toContain("--memory 15g");
  // --memory-swap = RAM + swap → 20 GB of swap: slow down at a peak, don't crash,
  // but not unlimited (that would flood the whole box's swap).
  expect(a).toContain("--memory-swap 35g");
});
