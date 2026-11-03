import { expect, test } from "bun:test";
import { ATTACH_ACCOUNT_PROFILE, ensureLiveAccountProfile, type LiveAccountProfileDeps } from "../src/liveAccountProfile";

function fixture(mounted = false) {
  const calls: string[][] = [];
  const state = { remote: false, missing: false, hostFails: false };
  const result = (stdout: string, code = 0) => ({ stdout, code, stderr: "", timedOut: false });
  const d: LiveAccountProfileDeps = {
    isRemote: () => state.remote,
    docker: async (_container, args) => {
      calls.push(args);
      if (args[0] === "inspect") return result(JSON.stringify({ id: "a".repeat(64), pid: 1234, mounts: mounted ? [{ Name: "claude-acct-backup", Destination: "/home/dev/.claude-accounts/backup" }] : [] }));
      return result("/var/lib/docker/volumes/claude-acct-backup/_data\n", state.missing ? 1 : 0);
    },
    host: async args => { calls.push(args); return result("", state.hostFails ? 1 : 0); },
  };
  return { d, state, calls, run: () => ensureLiveAccountProfile(d, "dev-fixture", "backup") };
}

test("an existing canonical account mount needs no host mutation", async () => {
  const h = fixture(true); h.state.remote = true;
  await h.run();
  expect(h.calls).toHaveLength(1);
});

test("an account added after container creation is attached from its original Docker volume", async () => {
  const h = fixture();
  await h.run();
  expect(h.calls[1]).toEqual(["volume", "inspect", "--format", "{{.Mountpoint}}", "claude-acct-backup"]);
  expect(h.calls[2]?.slice(3)).toEqual(["1234", "/var/lib/docker/volumes/claude-acct-backup/_data", "/home/dev/.claude-accounts/backup", "a".repeat(64)]);
  expect(h.calls.flat().some(x => x === "cp" || x === "rm" || x === "restart")).toBe(false);
});

test("missing source, unavailable host capability and missing remote mount fail without recreating the container", async () => {
  for (const reason of ["missing", "hostFails", "remote"] as const) {
    const h = fixture(); h.state[reason] = true;
    await expect(h.run()).rejects.toThrow();
    if (reason !== "hostFails") expect(h.calls.some(c => c[0] === "python3")).toBe(false);
  }
});

test("account IDs cannot inject host paths or shell commands", async () => {
  const h = fixture();
  await expect(ensureLiveAccountProfile(h.d, "dev-fixture", "../../other")).rejects.toThrow("Invalid Claude account ID");
  expect(h.calls).toEqual([]);
});

test("host-side PID validation remains enforced with Python optimization enabled", () => {
  const r = Bun.spawnSync(["python3", "-O", "-c", ATTACH_ACCOUNT_PROFILE, "1", "/unused", "/unused", "a".repeat(64)]);
  expect(r.exitCode).not.toBe(0);
  expect(r.stderr.toString()).toContain("Invalid container PID");
});
