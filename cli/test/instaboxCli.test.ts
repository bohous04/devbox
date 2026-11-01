import { expect, test } from "bun:test";
import { BASE_STEP, instaboxStatusLines, waitInstaboxJob } from "../src/main";
import { hostFlag, stripHostFlags } from "../src/picker";
import { sshAttachTarget } from "../src/recoveryOwner";
import type { BaseStep } from "../../devd/src/instabox/base";

test("hostFlag / stripHostFlags", () => {
  expect(hostFlag(["--instabox", "p/r"])).toBe("instabox");
  expect(hostFlag(["--on=instabox", "p/r"])).toBe("instabox");
  expect(hostFlag(["p/r"])).toBeUndefined();
  expect(stripHostFlags(["--on=instabox", "--agent", "codex", "p/r"])).toEqual(["--agent", "codex", "p/r"]);
});

test("M9: `--on instabox` / `--on vps` (with a space) like `--on=…`, other arguments stay", () => {
  expect(hostFlag(["--on", "instabox", "p/r"])).toBe("instabox");
  expect(stripHostFlags(["--on", "instabox", "--agent", "codex", "p/r"])).toEqual(["--agent", "codex", "p/r"]);
  expect(hostFlag(["--on", "vps", "p/r"])).toBeUndefined();
  expect(stripHostFlags(["p/r", "--on", "vps"])).toEqual(["p/r"]);
  expect(stripHostFlags(["--on=vps", "p/r"])).toEqual(["p/r"]);
  // `--on` without a valid host swallows nothing (the query stays a query).
  expect(hostFlag(["--on", "p/r"])).toBeUndefined();
  expect(stripHostFlags(["--on", "p/r"])).toEqual(["--on", "p/r"]);
  // the last option wins
  expect(hostFlag(["--on", "instabox", "--on", "vps", "p/r"])).toBeUndefined();
});

test("waitInstaboxJob reports steps and returns the finished job, throws on error", async () => {
  const seq = [{ status: "running", step: "machine" }, { status: "running", step: "volumes" }, { status: "done", step: "done" }];
  const steps: string[] = [];
  const j = await waitInstaboxJob({ instaboxJob: async () => seq.shift()! }, "j1", (s) => steps.push(s), async () => {});
  expect(j.status).toBe("done");
  expect(steps).toEqual(["machine", "volumes", "done"]);
  await expect(waitInstaboxJob({ instaboxJob: async () => ({ status: "error", step: "clone", error: "nope" }) }, "j2", () => {}, async () => {}))
    .rejects.toThrow("clone: nope");
});

test("instaboxStatusLines", () => {
  expect(instaboxStatusLines({ enabled: false })).toEqual(["InstaBox is not configured on devd."]);
  expect(instaboxStatusLines({
    enabled: true, ok: true, machines: 3, devboxMachines: 2, maxMachines: 5, storedBytes: 0, maxStoredBytes: 1,
    base: { snapshotId: "sn_1", builtAt: 1, stale: true }, orphans: [{ id: "m_9", name: "orph", state: "running" }],
    buildLeftovers: [{ id: "m_7", name: "devbox-base-build", state: "running" }], lost: ["dev-p-b"],
  })).toEqual([
    "InstaBox 3/5 machines (2 devbox)",
    "Base: sn_1 (stale — run `dev instabox rebuild-base`)",
    "Orphaned machine: orph (m_9, running) — delete it in the dashboard",
    "Leftover base-build machine: devbox-base-build (m_7, running) — delete it in the dashboard",
    "Session lost its machine: dev-p-b — end it with `dev end dev-p-b`",
  ]);
});

// Review (fix 1): the rebuild-base spinner must have an English label for EVERY BaseStep
// (devd/src/instabox/base.ts), not the raw key from the API. A fixed list (not Object.keys
// from devd, so the test also fails when a step is silently deleted from this array) + the type
// check via BaseStep make a missing label fail at compile time too (Record<BaseStep, …>).
test("BASE_STEP covers every BaseStep with a human label", () => {
  const steps: BaseStep[] = ["digest", "machine", "tools", "image", "snapshot", "cleanup", "done"];
  for (const s of steps) expect(typeof BASE_STEP[s]).toBe("string");
  expect(Object.keys(BASE_STEP).sort()).toEqual(steps.slice().sort());
});

test("sshAttachTarget also recognizes an attach into an InstaBox session (Warp recovery)", () => {
  expect(sshAttachTarget("ssh -t -o ServerAliveInterval=5 devbox docker -H ssh://ibx-m_1 exec -it dev-p-r bash -lc 'tmux attach -d -t =main'"))
    .toEqual({ host: "devbox", container: "dev-p-r", tmuxSession: "main" });
  expect(sshAttachTarget("ssh -t devbox docker exec -it dev-p-r bash -lc 'tmux attach -d -t =main'"))
    .toEqual({ host: "devbox", container: "dev-p-r", tmuxSession: "main" });
});
