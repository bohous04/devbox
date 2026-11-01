import { expect, test } from "bun:test";
import { liveAgentPresent, mountSpecDestination, observedMountDestinations, staleAccountMounts } from "../src/accountMountRepair";

test("mountSpecDestination reads the container path from a volume spec", () => {
  expect(mountSpecDestination("codex-acct-abc:/home/dev/.codex-accounts/abc")).toBe("/home/dev/.codex-accounts/abc");
  expect(mountSpecDestination("claude-acct-max20:/home/dev/.claude-accounts/max20:ro")).toBe("/home/dev/.claude-accounts/max20");
  expect(mountSpecDestination("not-a-path")).toBeNull();
});

test("staleAccountMounts is true only when an expected destination is missing", () => {
  const extra = "codex-acct-84102735-cebc-42bc-bd8b-6a9f75e4b9ce:/home/dev/.codex-accounts/84102735-cebc-42bc-bd8b-6a9f75e4b9ce";
  const observed = ["/home/dev/.codex", "/home/dev/.claude"];
  expect(staleAccountMounts([], observed)).toBe(false);
  expect(staleAccountMounts([extra], [...observed, "/home/dev/.codex-accounts/84102735-cebc-42bc-bd8b-6a9f75e4b9ce"])).toBe(false);
  expect(staleAccountMounts([extra], observed)).toBe(true);
});

test("observedMountDestinations reads Destination fields and rejects malformed inspect JSON", () => {
  expect(observedMountDestinations([{ Destination: "/home/dev/.codex" }, { Destination: "/workspace" }]))
    .toEqual(["/home/dev/.codex", "/workspace"]);
  expect(observedMountDestinations({ Destination: "/x" })).toBeNull();
  expect(observedMountDestinations([{ Name: "codex-home" }])).toBeNull();
});

test("liveAgentPresent detects harness processes and ignores sidecars", () => {
  expect(liveAgentPresent(["zsh", "sleep", "postgres"])).toBe(false);
  expect(liveAgentPresent(["zsh", "codex"])).toBe(true);
  expect(liveAgentPresent(["claude"])).toBe(true);
  expect(liveAgentPresent(["grok", "python"])).toBe(true);
});
