import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTAINER_SOCK, CONTAINER_UID, createSerial, createSshAgents, defaultRun } from "../src/sshAgent";

// createSerial() deletes the entry in `chains` from a `.then()` attached to `tail`
// (`job.catch(() => {})`), so the cleanup finishes one microtask tick LATER than
// `job` itself resolves — `await p` alone is not enough for that, but `setTimeout` is guaranteed
// to drain the microtask queue before the next synchronous check.
const flush = () => new Promise((r) => setTimeout(r, 0));
// Public test identity only; agent I/O is faked below and never contacts 1Password.
const IDENTITY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakePublicIdentityForAgentReuseTest comment";

// Regression: Bun.spawnSync does not follow runtime mutations of process.env (env is snapshotted
// at process start) — so this test MUST go through the real defaultRun, not
// through a fake `run` like all the other tests here. Without it, a bug where ssh-add
// never saw SSH_AUTH_SOCK would pass the whole suite without a trace (which happened
// in production). Before the defaultRun fix this test fails, because the env parameter is
// not passed anywhere and the child inherits only process.env without SOME_VAR.
test("defaultRun passes an env variable to the actually spawned child (not via process.env)", async () => {
  const r = await defaultRun(["sh", "-c", 'echo "$SOME_VAR"'], undefined, { SOME_VAR: "value-from-devd" });
  expect(r.code).toBe(0);
  expect(r.stdout.trim()).toBe("value-from-devd");
});

// Regression for task9-fix2: a missing binary (typically `setpriv` when dropping privileges)
// used to throw a raw synchronous exception from the real Bun.spawnSync instead of
// defaultRun returning the controlled { code, stderr } shape that activate() can
// wrap into a readable error. This test runs on the real
// defaultRun, not a fake — otherwise catching the exception could only be verified for show. `run()`
// (proc.ts) itself turns a missing binary into { code: 127, stderr } without an exception.
test("defaultRun on a missing binary does not throw, but returns a non-zero code with stderr", async () => {
  const r = await defaultRun(["definitely-not-a-real-binary-xyz"]);
  expect(r.code).not.toBe(0);
  expect(r.stderr.length).toBeGreaterThan(0);
});

function deps(over: Partial<Parameters<typeof createSshAgents>[0]> = {}) {
  const calls: string[][] = [];
  const envs: (Record<string, string> | undefined)[] = [];
  const base = {
    controlDir: (s: string) => `/ctl/${s}`,
    readKey: (title: string) => `-----BEGIN ${title} PRIVATE KEY-----\n`,
    run: (cmd: string[], stdin?: string, env?: Record<string, string>) => {
      calls.push(cmd);
      envs.push(env);
      if (cmd.includes("ssh-agent")) return { code: 0, stdout: "SSH_AUTH_SOCK=/ctl/x; export SSH_AUTH_SOCK;\nSSH_AGENT_PID=4242; export SSH_AGENT_PID;\n", stderr: "" };
      if (cmd.includes("-L")) return { code: 0, stdout: IDENTITY + "\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    // Default: devd already runs as the container uid → activate() starts ssh-agent/
    // ssh-add directly, unchanged from the state before task9-fix2. The privilege-
    // drop tests (root → setpriv) have their own getuid override, see below.
    getuid: () => CONTAINER_UID,
    rm: () => {},
  };
  return { d: { ...base, ...over }, calls, envs };
}

test("activation starts the agent on a socket in controlDir and loads the key", async () => {
  const { d, calls } = deps();
  const a = createSshAgents(d);
  const r = await a.activate("dev-web-app", "shop");
  expect(r.agentSock).toBe(CONTAINER_SOCK);
  expect(calls[0]).toEqual(["ssh-agent", "-a", "/ctl/dev-web-app/ssh-agent.sock"]);
  expect(calls[1]?.slice(0, 2)).toEqual(["ssh-add", "-"]);
});

// Regression: Bun.spawnSync does not see a runtime mutation of process.env, so SSH_AUTH_SOCK
// for ssh-add MUST go as the child's env (see defaultRun in sshAgent.ts), not via
// process.env.SSH_AUTH_SOCK = ... around the call.
test("activation passes SSH_AUTH_SOCK to the ssh-add call via env, not via process.env", async () => {
  const { d, calls, envs } = deps();
  await createSshAgents(d).activate("dev-web-app", "shop");
  const addIdx = calls.findIndex((c) => c[0] === "ssh-add");
  expect(addIdx).toBeGreaterThanOrEqual(0);
  expect(envs[addIdx]).toEqual({ SSH_AUTH_SOCK: "/ctl/dev-web-app/ssh-agent.sock" });
});

test("key material never appears in command arguments", async () => {
  const { d, calls } = deps();
  await createSshAgents(d).activate("dev-web-app", "shop");
  expect(calls.flat().join(" ")).not.toContain("PRIVATE KEY");
});

test("repeated activation cleans up the old agent first", async () => {
  const { d, calls } = deps();
  const a = createSshAgents(d);
  await a.activate("dev-web-app", "shop");
  await a.activate("dev-web-app", "other");
  expect(calls.some((c) => c[0] === "kill" && c[1] === "4242")).toBe(true);
});

test("the same key reuses the verified live agent even during a 1Password outage", async () => {
  let reads = 0;
  const { d, calls, envs } = deps({
    getuid: () => 0,
    readKey: () => { if (++reads > 1) throw new Error("1Password rate limited"); return "KEY\n"; },
  });
  const a = createSshAgents(d);
  await a.activate("s", "key");
  await expect(a.activate("s", "key")).resolves.toEqual({ agentSock: CONTAINER_SOCK });
  expect(reads).toBe(1);
  expect(calls.filter((c) => c.includes("ssh-agent"))).toHaveLength(1);
  expect(calls.some((c) => c[0] === "kill")).toBe(false);
  const probe = calls.findLastIndex((c) => c.includes("-L"));
  expect(calls[probe]).toEqual(["setpriv", "--reuid=1000", "--regid=1000", "--clear-groups", "ssh-add", "-L"]);
  expect(envs[probe]).toEqual({ SSH_AUTH_SOCK: "/ctl/s/ssh-agent.sock" });
});

for (const [reason, reply] of [
  ["dead socket", { code: 2, stdout: "", stderr: "Could not open a connection to your authentication agent." }],
  ["empty agent", { code: 1, stdout: "The agent has no identities.\n", stderr: "" }],
  ["different identity", { code: 0, stdout: "ssh-ed25519 AAAAOtherPublicKey\n", stderr: "" }],
  ["an extra unexpected key", { code: 0, stdout: IDENTITY + "\nssh-ed25519 AAAAOtherPublicKey\n", stderr: "" }],
] as const) {
  test(`the same title is reloaded if the check finds: ${reason}`, async () => {
    let reads = 0;
    const { d, calls } = deps({ readKey: () => { reads++; return "KEY\n"; } });
    const baseRun = d.run;
    let failNextProbe = false;
    d.run = (cmd, stdin, env) => {
      if (failNextProbe && cmd.includes("-L")) { failNextProbe = false; return reply; }
      return baseRun(cmd, stdin, env);
    };
    const a = createSshAgents(d);
    await a.activate("s", "key");
    failNextProbe = true;
    await a.activate("s", "key");
    expect(reads).toBe(2);
    expect(calls.filter((c) => c.includes("ssh-agent"))).toHaveLength(2);
    expect(calls.some((c) => c[0] === "kill")).toBe(true);
  });
}

test("failing to read a new key keeps the original working agent", async () => {
  const { d, calls } = deps({ readKey: (title) => { if (title === "new") throw new Error("rate limited"); return "KEY\n"; } });
  const a = createSshAgents(d);
  await a.activate("s", "old");
  await expect(a.activate("s", "new")).rejects.toThrow("rate limited");
  expect(calls.filter((c) => c.includes("ssh-agent"))).toHaveLength(1);
  expect(calls.some((c) => c[0] === "kill")).toBe(false);
  await expect(a.activate("s", "old")).resolves.toEqual({ agentSock: CONTAINER_SOCK });
});

test("revocation also removes a reused agent and the next activation must read the key", async () => {
  let reads = 0;
  const { d, calls } = deps({ readKey: () => { reads++; return "KEY\n"; } });
  const a = createSshAgents(d);
  await a.activate("s", "key");
  await a.activate("s", "key");
  await a.kill("s", "key");
  await a.activate("s", "key");
  expect(reads).toBe(2);
  expect(calls.filter((c) => c[0] === "kill")).toHaveLength(1);
});

test("an exception during ssh-add cleans up the new agent and the next activation does not take it over", async () => {
  const { d, calls } = deps();
  const baseRun = d.run;
  let fail = true;
  d.run = (cmd, stdin, env) => {
    if (fail && cmd.includes("ssh-add") && cmd.includes("-")) throw new Error("spawn failed");
    return baseRun(cmd, stdin, env);
  };
  const a = createSshAgents(d);
  await expect(a.activate("s", "key")).rejects.toThrow("spawn failed");
  expect(calls.some((c) => c[0] === "kill")).toBe(true);
  fail = false;
  await a.activate("s", "key");
  expect(calls.filter((c) => c.includes("ssh-agent"))).toHaveLength(2);
});

test("an ssh-add failure cleans up the socket and propagates the error", async () => {
  const { d } = deps({
    run: (cmd: string[]) => cmd[0] === "ssh-agent"
      ? { code: 0, stdout: "SSH_AGENT_PID=7; export SSH_AGENT_PID;\n", stderr: "" }
      : { code: 1, stdout: "", stderr: "bad key" },
  });
  let removed = 0;
  const a = createSshAgents({ ...d, rm: () => { removed++; } });
  await expect(a.activate("dev-web-app", "shop")).rejects.toThrow(/ssh-add/);
  expect(removed).toBeGreaterThan(0);
});

test("kill without a running agent is a no-op", async () => {
  const { d } = deps();
  await expect(createSshAgents(d).kill("unknown")).resolves.toBeUndefined();
});

// Review finding: reaper/DELETE used to call kill(session) without a title, so an expired/
// revoked grant for key A tore down the agent the session had meanwhile activated for key B.
// kill(session, title) now targets precisely — and is a no-op when the running agent belongs to a different
// title than the one the caller asks about.
test("kill(session, title) leaves an agent belonging to another key running", async () => {
  const { d, calls } = deps();
  const a = createSshAgents(d);
  await a.activate("dev-web-app", "other-key"); // pid 4242, title "other-key"
  await a.kill("dev-web-app", "shop");          // a grant for a DIFFERENT key (shop) expired
  expect(calls.some((c) => c[0] === "kill")).toBe(false);
});

test("kill(session, title) kills the agent that matches the given title", async () => {
  const { d, calls } = deps();
  const a = createSshAgents(d);
  await a.activate("dev-web-app", "shop"); // pid 4242, title "shop"
  await a.kill("dev-web-app", "shop");
  expect(calls.some((c) => c[0] === "kill" && c[1] === "4242")).toBe(true);
});

test("kill(session) without a title (activate's internal pattern) kills regardless of title", async () => {
  const { d, calls } = deps();
  const a = createSshAgents(d);
  await a.activate("dev-web-app", "shop"); // pid 4242
  await a.kill("dev-web-app");
  expect(calls.some((c) => c[0] === "kill" && c[1] === "4242")).toBe(true);
});

// task9-fix2: OpenSSH ssh-agent checks the peer uid on the socket — chown
// of the socket itself has no effect on that (devd runs as root, the container as
// uid 1000, and a client with a uid different from the agent gets "communication with agent
// failed"). So both ssh-agent and ssh-add must run AS the container uid.
test("activation as root starts ssh-agent and ssh-add wrapped via setpriv to the container uid", async () => {
  const { d, calls, envs } = deps({ getuid: () => 0 });
  const a = createSshAgents(d);
  await a.activate("dev-web-app", "shop");
  const setprivPrefix = ["setpriv", `--reuid=${CONTAINER_UID}`, `--regid=${CONTAINER_UID}`, "--clear-groups"];
  expect(calls[0]).toEqual([...setprivPrefix, "ssh-agent", "-a", "/ctl/dev-web-app/ssh-agent.sock"]);
  expect(calls[1]).toEqual([...setprivPrefix, "ssh-add", "-"]);
  // SSH_AUTH_SOCK must get through the wrapper too — the earlier regression fix must not be lost.
  const addIdx = calls.findIndex((c) => c.includes("ssh-add"));
  expect(envs[addIdx]).toEqual({ SSH_AUTH_SOCK: "/ctl/dev-web-app/ssh-agent.sock" });
});

// kill <pid> is not wrapped — root may signal a process of any uid, so
// killing an agent started as the container uid works directly even as root.
test("killing an agent started as root (via setpriv) sends kill directly, without a wrapper", async () => {
  const { d, calls } = deps({ getuid: () => 0 });
  const a = createSshAgents(d);
  await a.activate("dev-web-app", "shop"); // pid 4242
  await a.kill("dev-web-app", "shop");
  expect(calls.some((c) => c[0] === "kill" && c[1] === "4242")).toBe(true);
});

test("activation as the container uid starts ssh-agent and ssh-add directly, without a wrapper", async () => {
  const { d, calls } = deps({ getuid: () => CONTAINER_UID });
  const a = createSshAgents(d);
  await a.activate("dev-web-app", "shop");
  expect(calls[0]).toEqual(["ssh-agent", "-a", "/ctl/dev-web-app/ssh-agent.sock"]);
  expect(calls[1]?.slice(0, 2)).toEqual(["ssh-add", "-"]);
});

// Fail-closed: devd under a foreign uid (not root, not the container) has no permission to
// switch to the container uid via setpriv. Activation must fail IMMEDIATELY with a clear
// cause in the message — not silently start the agent as that foreign uid (that is exactly
// the bug this fix addresses, just one step further, and the symptom would then only show up
// in the container as "communication with agent failed", far from the cause).
test("activation under a foreign uid (not root, not the container) fails right away, without running any command", async () => {
  const { d, calls } = deps({ getuid: () => 1234 });
  const a = createSshAgents(d);
  await expect(a.activate("dev-web-app", "shop")).rejects.toThrow(/1234/);
  await expect(a.activate("dev-web-app", "shop")).rejects.toThrow(/uid/i);
  expect(calls.length).toBe(0);
});

// A missing/failing setpriv must surface as a readable ssh-agent error,
// not silently fall back to an unwrapped start as root.
test("a wrapper failure (setpriv missing/failing) propagates the error, never starts the agent as root", async () => {
  // getuid: 0 → wrap = withContainerUid, so EVERY run() call gets cmd[0]
  // === "setpriv" (ssh-agent and ssh-add are hidden behind it). The fake run here plays
  // the role of a missing/broken binary (see the defaultRun test above, which verifies the same
  // on the real spawnSync).
  const { d } = deps({
    getuid: () => 0,
    run: () => ({ code: 127, stdout: "", stderr: "setpriv: command not found" }),
  });
  const a = createSshAgents(d);
  await expect(a.activate("dev-web-app", "shop")).rejects.toThrow(/ssh-agent failed/);
  await expect(a.activate("dev-web-app", "shop")).rejects.toThrow(/setpriv/);
});

// Operations on one session are serialised: a kill called concurrently with activate must not
// hit the agent IN THE MIDDLE of activation (ssh-agent already runs, ssh-add has not run yet) —
// otherwise DELETE /api/ssh-grants or the reaper could kill the socket to which a key is
// just being added, and activate() would end with a confusing error about a dead agent.
test("activate and kill on one session are serialised (kill does not hit the agent mid-activation)", async () => {
  const order: string[] = [];
  // Hoisted out of controlDir (review finding): `sockPathFor` calls `controlDir` several times
  // (activate and kill), so `() => mkdtempSync(...)` inside would create a DIFFERENT
  // directory every time and leave needless empty temp folders behind.
  const ctlDir = mkdtempSync(join(tmpdir(), "ctl-"));
  const d = {
    controlDir: () => ctlDir,
    readKey: async () => { await new Promise((r) => setTimeout(r, 30)); return "KEY\n"; },
    run: (cmd: string[]) => { order.push(cmd[0]); return cmd[0] === "ssh-agent" ? { code: 0, stdout: "SSH_AGENT_PID=4242;", stderr: "" } : { code: 0, stdout: cmd.includes("-L") ? IDENTITY : "", stderr: "" }; },
    getuid: () => 1000,
  };
  const a = createSshAgents(d);
  const act = a.activate("dev-web-app", "shop");
  const kil = a.kill("dev-web-app", "shop");
  await Promise.all([act, kil]);
  // ssh-agent, ssh-add + identity check (the whole activation), only then kill
  expect(order).toEqual(["ssh-agent", "ssh-add", "ssh-add", "kill"]);
});

// Regression: `chains` in createSshAgents used to keep one resolved/rejected promise per session key
// forever (job.catch(() => {})) — for a long-lived devd with
// many different sessions (including gone ones) that is a slowly growing map that is never
// cleaned up. createSerial() now deletes the entry once the last queue for the key settles.
test("createSerial: size() is 1 while a job runs, and 0 after it settles (resolve and reject)", async () => {
  const s = createSerial();
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  const p = s.run("a", () => gate.then(() => "done"));
  expect(s.size()).toBe(1);
  release();
  await p;
  await flush();
  expect(s.size()).toBe(0);

  let reject: () => void = () => {};
  const gate2 = new Promise<void>((_, rej) => { reject = () => rej(new Error("boom")); });
  const p2 = s.run("b", () => gate2.then(() => "never")) ;
  expect(s.size()).toBe(1);
  reject();
  await p2.catch(() => {});
  await flush();
  expect(s.size()).toBe(0);
});

test("createSerial: a job queued behind a running one keeps the entry until BOTH settle", async () => {
  const s = createSerial();
  let releaseFirst: () => void = () => {};
  const firstGate = new Promise<void>((r) => { releaseFirst = r; });
  const first = s.run("k", () => firstGate);
  const second = s.run("k", async () => "second");
  expect(s.size()).toBe(1);   // still one entry for key "k", not two
  releaseFirst();
  await first;
  // the second job is still finishing (a microtask after the first settles) — the entry must not disappear early
  await second;
  await flush();
  expect(s.size()).toBe(0);
});

test("createSerial: jobs on the same key run in order, on different keys independently", async () => {
  const order: string[] = [];
  const s = createSerial();
  const p1 = s.run("x", async () => { await new Promise((r) => setTimeout(r, 20)); order.push("x1"); });
  const p2 = s.run("x", async () => { order.push("x2"); });
  const p3 = s.run("y", async () => { order.push("y1"); });   // different key — does not wait for "x"
  await Promise.all([p1, p2, p3]);
  expect(order.indexOf("x1")).toBeLessThan(order.indexOf("x2"));
  expect(order.indexOf("y1")).toBeLessThan(order.indexOf("x1"));   // "y" finishes first, because it does not wait for the "x" queue
});
