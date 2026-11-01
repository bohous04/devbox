import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getRepoAgent, getSession, insertSession, listEvents, logEvent } from "../src/db";
import { dockerArgv, setRemoteDocker } from "../src/dockerTarget";
import { clearInstaboxIps, isInstaboxAddress } from "../src/network";
import { IbxPreconditionError, tailscaleJoinCmd } from "../src/instabox/sessions";
import { SessionBusyError } from "../src/sessions";
import { ibxSetup, T, waitJob } from "./helpers/instaboxSetup";

let env: ReturnType<typeof ibxSetup> | null = null;
afterEach(() => { env?.cleanup(); env = null; clearInstaboxIps(); });

test("create: full flow → instabox session, alias, container on the VM path, all volumes, desktop", async () => {
  env = ibxSetup({ accountIds: { claude: ["a1"], codex: ["g1"] } });
  const { db, client, ibx, opsCalls, containers } = env;
  const job = await ibx.startCreate(T);
  expect(job.sessionId).toBe("dev-p-r");
  const done = await waitJob(ibx, job.id);
  expect(done).toMatchObject({ status: "done", step: "done" });
  const s = getSession(db, "dev-p-r")!;
  expect(s).toMatchObject({ host: "instabox", instabox_machine_id: "m_1", worktree: null, branch: null, agent: "claude" });
  expect(dockerArgv("dev-p-r")).toEqual(["docker", "-H", "ssh://ibx-m_1"]);
  expect(client.calls[0]).toBe("usage");
  expect(client.calls).toContain("create sn_base");
  expect(client.calls.some((c) => c.startsWith("run m_1 sudo -n tailscale status"))).toBe(true);
  expect(client.calls.some((c) => c.startsWith("run m_1 sudo -n mkdir -p"))).toBe(true);
  expect(client.calls).toContain("desktopStart m_1");
  expect(opsCalls).toEqual(expect.arrayContaining([
    "copy claude-home", "copy codex-home", "copy grok-home", "copy claude-acct-a1", "copy codex-acct-g1",
    "docker run --rm", "run dev-p-r /data/devbox/ws/dev-p-r",
  ]));
  expect(containers[0]!.mounts).toContain("/var/run/docker.sock:/var/run/docker.sock");
  expect(containers[0]!.mounts).toContain("/tmp/.X11-unix:/tmp/.X11-unix");
  expect(containers[0]!.env.DOCKER_HOST).toBeUndefined();
  // C1: the container in the VM talks to devd only via the VM listener (vmPort 4301), not via the main port.
  expect(containers[0]!.env.DEVD_URL).toBe("http://100.1.1.1:4301");
  expect(containers[0]!.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe("http://100.1.1.1:4301");
  expect(client.calls.some((c) => c.includes("curl -sf -m 5 'http://100.1.1.1:4301/api/health'"))).toBe(true);
  // C1: the machine's tailnet IP is recorded and the approval gates reject it.
  expect(s.instabox_ts_ip).toBe("100.100.0.1");
  expect(isInstaboxAddress("100.100.0.1")).toBe(true);
  expect(listEvents(db, { type: "open-instabox" }).length).toBe(1);
});

test("R3: a repo with a VPS session gets a NEW instabox session with an ordinal id", async () => {
  env = ibxSetup();
  insertSession(env.db, { id: "dev-p-r", folder: "f", project: "p", repo: "r", container: "dev-p-r", port_base: 40100, status: "running", solo: 0, created_at: 1, last_active_at: 1, important: 0 });
  const job = await env.ibx.startCreate(T);
  expect(job.sessionId).toBe("dev-p-r-2");
  expect((await waitJob(env.ibx, job.id)).status).toBe("done");
  expect(getSession(env.db, "dev-p-r")!.host).toBe("vps");
  expect(getSession(env.db, "dev-p-r-2")!.host).toBe("instabox");
});

test("create rollback on clone failure: machine killed, session deleted, alias gone", async () => {
  env = ibxSetup({ ops: { remoteDocker: async () => ({ code: 128, stderr: "fatal: repository not found" }) } });
  const done = await waitJob(env.ibx, (await env.ibx.startCreate(T)).id);
  expect(done).toMatchObject({ status: "error", step: "clone" });
  expect(done.error).toContain("repository not found");
  expect(getSession(env.db, "dev-p-r")).toBeNull();
  expect(env.client.machines.size).toBe(0);
  expect(dockerArgv("dev-p-r")).toEqual(["docker"]);
  expect(listEvents(env.db, { type: "instabox_create_failed" }).length).toBe(1);
});

test("create: tailscale fails → a clear error and rollback", async () => {
  env = ibxSetup();
  env.client.runResults.push(["sudo -n tailscale status", { exitCode: 1, stdout: "", stderr: "auth key expired" }]);
  const done = await waitJob(env.ibx, (await env.ibx.startCreate(T)).id);
  expect(done).toMatchObject({ status: "error", step: "tailscale" });
  expect(done.error).toContain("Tailscale");
  expect(env.client.machines.size).toBe(0);
});

test("preflight: full including a foreign machine (R4), missing base, missing Tailscale key", async () => {
  env = ibxSetup();
  env.client.maxMachines = 1;
  env.client.foreignMachines = 1; // a foreign `vps02` on the account, no devbox machine
  await expect(env.ibx.startCreate(T)).rejects.toMatchObject({ status: 409 });
  expect(env.client.calls).not.toContain("create sn_base");
  expect(getSession(env.db, "dev-p-r")).toBeNull();
  env.db.run("DELETE FROM instabox_base");
  await expect(env.ibx.startCreate(T)).rejects.toBeInstanceOf(IbxPreconditionError);
  await expect(env.ibx.startCreate(T)).rejects.toMatchObject({ status: 503 });
  env.cleanup();
  env = ibxSetup({ tsKey: null });
  await expect(env.ibx.startCreate(T)).rejects.toMatchObject({ status: 503 });
});

test("stop/end during create → 409 busy (lock [id])", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  env = ibxSetup({ ops: { copyVolume: async () => { await gate; } } });
  const job = await env.ibx.startCreate(T);
  await expect(env.mgr.stop(job.sessionId)).rejects.toBeInstanceOf(SessionBusyError);
  await expect(env.mgr.end(job.sessionId)).rejects.toBeInstanceOf(SessionBusyError);
  release();
  expect((await waitJob(env.ibx, job.id)).status).toBe("done");
});

test("SessionManager: stop → pause, open on a stopped instabox session → resume, not docker", async () => {
  env = ibxSetup();
  const { db, ibx, mgr, client, opsCalls } = env;
  await waitJob(ibx, (await ibx.startCreate(T)).id);
  await mgr.stop("dev-p-r");
  expect(getSession(db, "dev-p-r")!.status).toBe("stopped");
  expect(client.machines.get("m_1")!.state).toBe("suspended");
  expect(dockerArgv("dev-p-r")).toEqual(["docker"]); // a paused session has no alias
  const r = await mgr.open({ folder: "f", project: "p", repo: "r" });
  expect(r.created).toBe(false);
  expect(r.session.id).toBe("dev-p-r");
  expect(client.calls).toContain("resume m_1");
  expect(getSession(db, "dev-p-r")!.status).toBe("running");
  expect(dockerArgv("dev-p-r")).toEqual(["docker", "-H", "ssh://ibx-m_1"]);
  expect(opsCalls.filter((c) => c.startsWith("creds")).map((c) => c.split(" ")[1])).toEqual(["both", "push"]);
  expect(listEvents(db, { session: "dev-p-r", type: "stop" })[0]!.data).toContain("instabox");
});

test("SessionManager.end: machine killed, row gone, alias gone", async () => {
  env = ibxSetup();
  await waitJob(env.ibx, (await env.ibx.startCreate(T)).id);
  await env.mgr.end("dev-p-r");
  expect(env.client.calls).toContain("kill m_1");
  expect(env.client.machines.size).toBe(0);
  expect(getSession(env.db, "dev-p-r")).toBeNull();
  expect(dockerArgv("dev-p-r")).toEqual(["docker"]);
  expect(listEvents(env.db, { session: "dev-p-r", type: "end" }).length).toBe(1);
});

test("new account after create: push to the VM, no local recreate (Review Focus 5)", async () => {
  env = ibxSetup({ accountIds: { claude: [], codex: [] } });
  await waitJob(env.ibx, (await env.ibx.startCreate(T)).id);
  env.accountIds.claude.push("a2");
  await env.ibx.syncAllCreds();
  // I2: the periodic sync goes file by file (the alias is checked before each one).
  expect(env.opsCalls.slice(-3)).toEqual(["creds both claude-home", "creds both codex-home", "creds both claude-acct-a2"]);
  expect(await env.mgr.repairAccountMounts("dev-p-r")).toBe(false);
  await expect(env.mgr.recreate("dev-p-r")).rejects.toThrow("InstaBox");
  expect(env.opsCalls.filter((c) => c.startsWith("run ")).length).toBe(1); // only the original create
});

test("desktopLink: control first invalidates old links", async () => {
  env = ibxSetup();
  await waitJob(env.ibx, (await env.ibx.startCreate(T)).id);
  const s = getSession(env.db, "dev-p-r")!;
  const view = await env.ibx.desktopLink(s, false);
  expect(view.url).toContain("dashboard.instabox.sh");
  expect(env.client.calls).toContain("desktopLink m_1 true");
  await env.ibx.desktopLink(s, true);
  expect(env.client.calls.slice(-2)).toEqual(["desktopRevoke m_1", "desktopLink m_1 false"]);
});

test("create: every container mount from /data/devbox exists in the VM (a directory from mkdir or a written file)", async () => {
  const gh = mkdtempSync(join(tmpdir(), "ibx-gh-"));
  writeFileSync(join(gh, "hosts.yml"), "github.com: {}\n");
  writeFileSync(join(gh, "config.yml"), "git_protocol: https\n");
  env = ibxSetup({
    ghConfigDir: gh,
    mgr: { issuePlaceholder: (s) => `ph-${s}`, giteaInstances: () => [{ name: "infra", url: "https://git.example" }] },
  });
  const { client, ibx, containers, controlRoot } = env;
  expect((await waitJob(ibx, (await ibx.startCreate(T)).id)).status).toBe("done");
  const mkdir = client.calls.find((c) => c.startsWith("run m_1 sudo -n mkdir -p"))!;
  const sources = containers[0]!.mounts.map((m) => m.slice(0, m.indexOf(":"))).filter((p) => p.startsWith("/data/devbox"));
  expect(sources).toEqual(expect.arrayContaining([
    "/data/devbox/ctl/dev-p-r", "/data/devbox/ctl/dev-p-r/gitea-tokens.json",
    "/data/devbox/claude-projects/dev-p-r", "/data/devbox/secrets/gh",
  ]));
  for (const src of sources) expect(mkdir.includes(`'${src}'`) || client.files.has(`m_1:${src}`)).toBe(true);
  // The placeholder in the VM is THE SAME one remoteRunOpts wrote locally (key = host devdUrl, not the real token).
  const tokens = client.files.get("m_1:/data/devbox/ctl/dev-p-r/gitea-tokens.json")!;
  expect(JSON.parse(tokens)).toEqual({ "100.1.1.1:4301": "ph-dev-p-r" });
  expect(tokens).toBe(readFileSync(join(controlRoot, "dev-p-r", "gitea-tokens.json"), "utf8"));
  expect(client.files.get("m_1:/data/devbox/secrets/gh/hosts.yml")).toBe("github.com: {}\n");
  expect(client.files.has("m_1:/data/devbox/secrets/gh/config.yml")).toBe(true);
});

test("create rollback also cleans up the local control dir with the placeholder", async () => {
  env = ibxSetup({
    ops: { remoteDocker: async () => ({ code: 128, stderr: "nope" }) },
    mgr: { issuePlaceholder: (s) => `ph-${s}`, giteaInstances: () => [{ name: "infra", url: "https://git.example" }] },
  });
  expect((await waitJob(env.ibx, (await env.ibx.startCreate(T)).id)).status).toBe("error");
  expect(existsSync(join(env.controlRoot, "dev-p-r"))).toBe(false);
});

test("syncAllCreds: an error on one file is logged, not reported as a logout", async () => {
  const notes: string[] = [];
  env = ibxSetup({
    notify: (_t, m) => notes.push(m),
    ops: {
      syncCreds: async () => [
        { file: "claude-home/.credentials.json", volume: "claude-home", action: "none", local: null, remote: null, error: "timeout" },
        { file: "codex-home/auth.json", volume: "codex-home", action: "none", local: null, remote: null },
      ],
    },
  });
  await waitJob(env.ibx, (await env.ibx.startCreate(T)).id);
  const errs: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { errs.push(a.join(" ")); };
  try { await env.ibx.syncAllCreds(); } finally { console.error = orig; }
  expect(notes).toEqual(["InstaBox: codex-home/auth.json is not logged in on either side — log in again"]);
  expect(errs.some((e) => e.includes("claude-home/.credentials.json") && e.includes("timeout"))).toBe(true);
});

const GITEA = { issuePlaceholder: (s: string) => `ph-${s}`, giteaInstances: () => [{ name: "infra", url: "https://git.example/" }] };

test("rollback after the secrets step invalidates the session placeholder and logs the failed kill", async () => {
  const revoked: string[] = [];
  env = ibxSetup({ ops: { remoteDocker: async () => ({ code: 128, stderr: "nope" }) }, mgr: GITEA, revokePlaceholder: (s) => revoked.push(s) });
  env.client.failNext.set("kill", new Error("api down"));
  const errs: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { errs.push(a.map(String).join(" ")); };
  try {
    expect(await waitJob(env.ibx, (await env.ibx.startCreate(T)).id)).toMatchObject({ status: "error", step: "clone" });
  } finally { console.error = orig; }
  expect(revoked).toEqual(["dev-p-r"]);
  expect(errs.some((e) => e.includes("kill m_1") && e.includes("api down"))).toBe(true);
});

test("gitea clone goes through the git proxy with a placeholder — the real token never reaches the VM", async () => {
  const REAL = "REALTOKEN-abc";
  const sent: { args: string[]; stdin?: string }[] = [];
  env = ibxSetup({
    mgr: { ...GITEA, credentials: () => ({ GIT_CONFIG_VALUE_0: `Authorization: Basic ${btoa(`devbox:${REAL}`)}` }) },
    ops: { remoteDocker: async (_r, args, _t, stdin) => { sent.push({ args, stdin }); return { code: 0, stderr: "" }; } },
  });
  const url = "https://git.example/team/r.git";
  expect((await waitJob(env.ibx, (await env.ibx.startCreate({ ...T, cloneUrl: url })).id)).status).toBe("done");
  const { args, stdin } = sent[0]!;
  expect(stdin).toBeUndefined();
  expect(args).toContain("credential.helper=/usr/local/bin/git-credential-devbox");
  expect(args).toContain("url.http://100.1.1.1:4301/git/infra/.insteadOf=https://git.example/");
  expect(args).toContain("/data/devbox/ctl/dev-p-r/gitea-tokens.json:/run/devbox-git/gitea-tokens.json:ro");
  expect(args.slice(-4)).toEqual(["clone", "--", url, "/workspace"]);
  const everything = JSON.stringify([sent, env.client.calls, [...env.client.files.values()], env.containers]);
  expect(everything).not.toContain(REAL);
  expect(everything).not.toContain(btoa(`devbox:${REAL}`));
  expect(everything).not.toContain("Authorization");
});

test("github clone: gh mount from RunOpts, no insteadOf", async () => {
  const gh = mkdtempSync(join(tmpdir(), "ibx-gh-"));
  const sent: string[][] = [];
  env = ibxSetup({ ghConfigDir: gh, ops: { remoteDocker: async (_r, args) => { sent.push(args); return { code: 0, stderr: "" }; } } });
  expect((await waitJob(env.ibx, (await env.ibx.startCreate(T)).id)).status).toBe("done");
  expect(sent[0]).toContain("/data/devbox/secrets/gh:/home/dev/.config/gh:ro");
  expect(sent[0]!.some((a) => a.includes("insteadOf"))).toBe(false);
});

test("lock [id] cannot be taken → job error, no phantom row", async () => {
  env = ibxSetup();
  let release!: () => void;
  const holder = env.mgr.withLock(["dev-p-r"], "test", () => new Promise<void>((r) => { release = r; }));
  const errs: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { errs.push(a.map(String).join(" ")); };
  let job;
  try { job = await env.ibx.startCreate(T); await Bun.sleep(5); } finally { console.error = orig; }
  expect(env.ibx.job(job.id)).toMatchObject({ status: "error" });
  expect(env.ibx.job(job.id)!.error).toBeTruthy();
  expect(getSession(env.db, "dev-p-r")).toBeNull();
  expect(env.client.calls).not.toContain("create sn_base");
  release();
  await holder;
});

test("syncAllCreds skips a session whose create is still running", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  env = ibxSetup({ ops: { copyVolume: async () => { await gate; } } });
  const job = await env.ibx.startCreate(T);
  await env.ibx.syncAllCreds();
  expect(env.opsCalls.some((c) => c.startsWith("creds"))).toBe(false);
  release();
  await waitJob(env.ibx, job.id);
  await env.ibx.syncAllCreds();
  expect(env.opsCalls.some((c) => c.startsWith("creds both"))).toBe(true);
});

test("open on an InstaBox session remembers the explicit agent", async () => {
  env = ibxSetup();
  await waitJob(env.ibx, (await env.ibx.startCreate(T)).id);
  const r = await env.mgr.open({ folder: "f", project: "p", repo: "r", agent: "codex" });
  expect(r.session.id).toBe("dev-p-r");
  expect(getRepoAgent(env.db, "f", "p", "r")).toBe("codex");
});

test("sweepInterruptedCreates: a create interrupted by a devd restart is cleaned up like a rollback, finished and failed ones are not", async () => {
  const revoked: string[] = [];
  env = ibxSetup({ revokePlaceholder: (s) => revoked.push(s) });
  const { db, client, ibx, controlRoot } = env;
  const row = { folder: "f", project: "p", status: "running" as const, solo: 0 as const, created_at: 1, last_active_at: 1, important: 0 as const, host: "instabox" as const };
  // a: interrupted after the machine was created (machine id in the DB)
  const ma = await client.create("sn", { name: "a", metadata: { devbox: "1", session: "dev-p-a" } });
  insertSession(db, { ...row, id: "dev-p-a", repo: "a", container: "dev-p-a", port_base: 40100, instabox_machine_id: ma.id });
  logEvent(db, "dev-p-a", "instabox_create_start", {});
  mkdirSync(join(controlRoot, "dev-p-a"), { recursive: true });
  // b: interrupted before the machine id was written — the machine is found by session metadata
  const mb = await client.create("sn", { name: "b", metadata: { devbox: "1", session: "dev-p-b" } });
  insertSession(db, { ...row, id: "dev-p-b", repo: "b", container: "dev-p-b", port_base: 40110 });
  logEvent(db, "dev-p-b", "instabox_create_start", {});
  // c: a finished create
  const mc = await client.create("sn", { name: "c", metadata: { devbox: "1", session: "dev-p-c" } });
  insertSession(db, { ...row, id: "dev-p-c", repo: "c", container: "dev-p-c", port_base: 40120, instabox_machine_id: mc.id });
  logEvent(db, "dev-p-c", "instabox_create_start", {});
  logEvent(db, "dev-p-c", "open-instabox", { machine: mc.id });
  // d: a VPS session with the same events is never touched
  insertSession(db, { ...row, id: "dev-p-d", repo: "d", container: "dev-p-d", port_base: 40130, host: "vps" });
  logEvent(db, "dev-p-d", "instabox_create_start", {});
  // a foreign machine without devbox=1 with the same session metadata must not disappear
  const foreign = await client.create("sn", { name: "x", metadata: { session: "dev-p-b" } });

  const orig = console.error;
  console.error = () => {};
  let swept: string[];
  try { swept = await ibx.sweepInterruptedCreates(); } finally { console.error = orig; }
  expect(swept.sort()).toEqual(["dev-p-a", "dev-p-b"]);
  expect(getSession(db, "dev-p-a")).toBeNull();
  expect(getSession(db, "dev-p-b")).toBeNull();
  expect(getSession(db, "dev-p-c")).not.toBeNull();
  expect(getSession(db, "dev-p-d")).not.toBeNull();
  expect(client.machines.has(ma.id)).toBe(false);
  expect(client.machines.has(mb.id)).toBe(false);
  expect(client.machines.has(mc.id)).toBe(true);
  expect(client.machines.has(foreign.id)).toBe(true);
  expect(existsSync(join(controlRoot, "dev-p-a"))).toBe(false);
  expect(revoked.sort()).toEqual(["dev-p-a", "dev-p-b"]);
  expect(listEvents(db, { type: "instabox_create_failed" }).map((e) => JSON.parse(e.data!).step)).toEqual(["interrupted", "interrupted"]);
  // a second pass does nothing
  expect(await ibx.sweepInterruptedCreates()).toEqual([]);
});

test("C1: `tailscale ip -4` fails or returns no tailnet address → create fails at the tailscale step and rolls back", async () => {
  env = ibxSetup();
  env.client.runResults.push(["tailscale ip -4", { exitCode: 0, stdout: "192.168.1.5\n", stderr: "" }]);
  const done = await waitJob(env.ibx, (await env.ibx.startCreate(T)).id);
  expect(done).toMatchObject({ status: "error", step: "tailscale" });
  expect(done.error).toContain("tailnet IPv4");
  expect(env.client.machines.size).toBe(0);
  expect(isInstaboxAddress("192.168.1.5")).toBe(false);
});

test("I6: the Tailscale auth key never reaches the job error (neither stderr nor a client exception), not even truncated", async () => {
  const KEY = "tskey-auth-SECRET0123456789";
  env = ibxSetup({ tsKey: KEY });
  env.client.runResults.push(["sudo -n tailscale status", { exitCode: 1, stdout: "", stderr: `${"x".repeat(290)} invalid key ${KEY} (expired)` }]);
  let done = await waitJob(env.ibx, (await env.ibx.startCreate(T)).id);
  expect(done.status).toBe("error");
  expect(done.error).not.toContain("SECRET");
  expect(done.error).not.toContain("tskey-auth");
  env.cleanup();
  env = ibxSetup({ tsKey: KEY });
  const run = env.client.run.bind(env.client);
  env.client.run = async (id: string, cmd: string) => { if (cmd.startsWith("sudo -n tailscale status")) throw new Error(`exec failed: envs {"TS_KEY":"${KEY}"}`); return run(id, cmd); };
  done = await waitJob(env.ibx, (await env.ibx.startCreate(T)).id);
  expect(done.status).toBe("error");
  expect(done.error).toContain("[redacted]");
  expect(done.error).not.toContain(KEY);
  const events = JSON.stringify(listEvents(env.db, { type: "instabox_create_failed" }));
  expect(events).not.toContain(KEY);
});

test("I3: resume where tailscale fails after the machine wakes → machine paused again, session stopped, error propagated", async () => {
  env = ibxSetup();
  const { db, ibx, mgr, client } = env;
  await waitJob(ibx, (await ibx.startCreate(T)).id);
  await mgr.stop("dev-p-r");
  client.runResults.push(["sudo -n tailscale status", { exitCode: 1, stdout: "", stderr: "tailnet down" }]);
  const errs: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { errs.push(a.map(String).join(" ")); };
  try {
    await expect(ibx.resume(getSession(db, "dev-p-r")!)).rejects.toThrow("tailnet down");
  } finally { console.error = orig; }
  expect(client.calls.slice(-1)).toEqual(["pause m_1"]);
  expect(client.machines.get("m_1")!.state).toBe("suspended");
  expect(getSession(db, "dev-p-r")!.status).toBe("stopped");
  expect(dockerArgv("dev-p-r")).toEqual(["docker"]);
  // a failure of that pause is only logged, the original error propagates
  client.failNext.set("pause", new Error("api down"));
  console.error = (...a: unknown[]) => { errs.push(a.map(String).join(" ")); };
  try {
    await expect(ibx.resume(getSession(db, "dev-p-r")!)).rejects.toThrow("tailnet down");
  } finally { console.error = orig; }
  expect(errs.some((e) => e.includes("m_1") && e.includes("api down"))).toBe(true);
});

test("I2: pause removes the alias BEFORE client.pause; if the pause fails, the alias comes back", async () => {
  env = ibxSetup();
  const { db, ibx, client } = env;
  await waitJob(ibx, (await ibx.startCreate(T)).id);
  const seen: string[][] = [];
  const pause = client.pause.bind(client);
  client.failNext.set("pause", new Error("api down"));
  client.pause = async (id) => { seen.push(dockerArgv("dev-p-r")); return pause(id); };
  await expect(ibx.pause(getSession(db, "dev-p-r")!)).rejects.toThrow("api down");
  expect(seen[0]).toEqual(["docker"]);
  expect(dockerArgv("dev-p-r")).toEqual(["docker", "-H", "ssh://ibx-m_1"]);
  expect(getSession(db, "dev-p-r")!.status).toBe("running");
  await ibx.pause(getSession(db, "dev-p-r")!);
  expect(seen[1]).toEqual(["docker"]);
  expect(dockerArgv("dev-p-r")).toEqual(["docker"]);
});

test("I2: syncAllCreds under the session lock — a held lock skips, a vanished alias stops further files", async () => {
  let ibxRef: { container: string } | null = null;
  const synced: string[] = [];
  env = ibxSetup({
    accountIds: { claude: ["a1"], codex: [] },
    ops: {
      syncCreds: async (_r, files) => {
        synced.push(files.map((f) => f.volume).join(","));
        // After the first file a "pause outside the lock" (e.g. rollback) — the alias disappears.
        if (ibxRef && synced.length === 1) setRemoteDocker(ibxRef.container, null);
        return [];
      },
    },
  });
  await waitJob(env.ibx, (await env.ibx.startCreate(T)).id);
  synced.length = 0;
  let release!: () => void;
  const holder = env.mgr.withLock(["dev-p-r"], "stop", () => new Promise<void>((r) => { release = r; }));
  await env.ibx.syncAllCreds();
  expect(synced).toEqual([]); // lock held (stop running) → skipped
  release();
  await holder;
  // During the sync it holds the lock: stop gets busy.
  let busyDuring = false;
  const ops = env.ibx as unknown as { ops: { syncCreds: (...a: unknown[]) => Promise<unknown[]> } };
  const inner = ops.ops.syncCreds;
  ops.ops.syncCreds = async (...a: unknown[]) => {
    busyDuring ||= await env!.mgr.stop("dev-p-r").then(() => false, (e) => e instanceof SessionBusyError);
    return inner(...a);
  };
  ibxRef = { container: "dev-p-r" };
  await env.ibx.syncAllCreds();
  expect(busyDuring).toBe(true);
  expect(synced).toEqual(["claude-home"]); // alias gone → neither codex-home nor claude-acct-a1 is synced
});

test("tailscaleJoinCmd: up only when Tailscale is not running, health with retries", () => {
  const c = tailscaleJoinCmd("ibx-m-1", "http://100.1.1.1:4301/api/health");
  expect(c.startsWith("sudo -n tailscale status >/dev/null 2>&1 || sudo -n tailscale up --auth-key=\"$TS_KEY\" --hostname='ibx-m-1' || exit 2; ")).toBe(true);
  expect(c).toContain("for i in $(seq 1 30); do curl -sf -m 5 'http://100.1.1.1:4301/api/health' >/dev/null && exit 0; sleep 3; done");
  expect(c).not.toContain("tskey");
});
