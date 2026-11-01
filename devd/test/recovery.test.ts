import { expect, test } from "bun:test";
import { recoverManagedSession, startRecovery, type RecoveryOperations } from "../src/recovery";
import type { SessionRow } from "../src/db";

function fixture(state: "running" | "stopped" | "missing" = "stopped") {
  const row: SessionRow = { id: "dev-apps-example", container: "dev-apps-example", folder: "apps", project: "apps",
    repo: "example", solo: 0, agent: "codex", port_base: 41000, status: "running", created_at: 1, last_active_at: 2, important: 0 };
  const calls: string[] = [];
  let observed = { state, workspace: "/srv/dev/exact-worktree" };
  const ops: RecoveryOperations = {
    get: () => row, hasStopIntent: () => false, markStopped: () => { calls.push("stop-intent"); row.status = "stopped"; },
    hasWorkspace: () => true, workspace: () => "/srv/dev/exact-worktree", inspect: async () => observed,
    ensureDind: async () => { calls.push("dind-ready"); }, hasJournal: () => true,
    create: async () => { calls.push("create"); observed = { ...observed, state: "running" }; },
    start: async () => { calls.push("start"); observed = { ...observed, state: "running" }; },
    ready: async () => { calls.push("tmux-ready"); }, restored: () => { calls.push("restored"); },
  };
  return { row, calls, ops, observed };
}

test("pending DinD prevents starting the session container", async () => {
  const f = fixture();
  f.ops.ensureDind = async () => { throw Error("DinD not ready"); };
  await expect(recoverManagedSession(f.ops)).rejects.toThrow("DinD not ready");
  expect(f.calls).toEqual([]);
  expect(f.row.status).toBe("running"); // desired state survives for retry
});

test("manual stop intent in a running row is finalized without resurrecting Docker", async () => {
  const f = fixture();
  f.ops.hasStopIntent = () => true;
  await recoverManagedSession(f.ops);
  expect(f.calls).toEqual(["stop-intent"]);
  expect(f.row.status).toBe("stopped");
});

test("already-running container with pending tmux remains retryable without another start", async () => {
  const f = fixture("running");
  let ready = false;
  f.ops.ready = async () => { if (!ready) throw Error("tmux pending"); };
  await expect(recoverManagedSession(f.ops)).rejects.toThrow("tmux pending");
  ready = true;
  await recoverManagedSession(f.ops);
  expect(f.calls).toEqual(["dind-ready", "dind-ready"]);
  expect(f.row.last_active_at).toBe(2);
});

test("missing journal or mismatching workspace refuses all recovery mutations", async () => {
  const missing = fixture("missing");
  missing.ops.hasJournal = () => false;
  await expect(recoverManagedSession(missing.ops)).rejects.toThrow("no exact recovery journal");
  expect(missing.calls).toEqual([]);
  const wrong = fixture();
  wrong.observed.workspace = "/srv/dev/other";
  await expect(recoverManagedSession(wrong.ops)).rejects.toThrow("workspace differs");
  expect(wrong.calls).toEqual([]);
});

test("intentional stopped rows stay stopped; restoration preserves activity and agent", async () => {
  const stopped = fixture();
  stopped.row.status = "stopped";
  await recoverManagedSession(stopped.ops);
  expect(stopped.calls).toEqual([]);
  const active = fixture();
  await recoverManagedSession(active.ops);
  expect(active.calls).toEqual(["dind-ready", "start", "tmux-ready", "restored"]);
  expect(active.row).toMatchObject({ agent: "codex", last_active_at: 2, port_base: 41000 });
});

test("startup recovery retries transient failures, without replaying successful sessions", async () => {
  const calls: string[] = [];
  const errors: string[] = [];
  let attempts = 0;
  const job = startRecovery({ ids: ["first", "second", "first"], delayMs: 1, maxAttempts: 3,
    recover: async id => { calls.push(id); if (id === "second" && attempts++ === 0) throw Error("Docker starting"); },
    failed: id => errors.push(id),
  });
  expect(await job.done).toEqual([]);
  expect(calls).toEqual(["first", "second", "second"]);
  expect(errors).toEqual(["second"]);
});

test("startup recovery reports unresolved sessions after its retry bound", async () => {
  let attempts = 0;
  const job = startRecovery({ ids: ["missing"], delayMs: 1, maxAttempts: 2,
    recover: async () => { attempts++; throw Error("missing retained workspace"); },
  });
  expect(await job.done).toEqual(["missing"]);
  expect(attempts).toBe(2);
});
