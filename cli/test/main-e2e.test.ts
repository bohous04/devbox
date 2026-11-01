import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../devd/src/api";
import { CloneQueue } from "../../devd/src/clone";
import { DEFAULT_CONFIG } from "../../devd/src/config";
import { getSession, insertSession, openDb } from "../../devd/src/db";
import { SessionManager } from "../../devd/src/sessions";
import type { TreeProject } from "../../devd/src/tree";

const db = openDb(":memory:");
const root = mkdtempSync(join(tmpdir(), "cli-e2e-"));
const mgr = new SessionManager({ db, cfg: DEFAULT_CONFIG, root, image: "unused", extraMounts: [], controlRoot: join(root, "ctl") });
const tree = async (): Promise<TreeProject[]> => [
  { folder: "acme", project: "shop", repos: [{ name: "cms", cloneUrl: "https://x/cms.git", provider: "github", cloned: false }] },
];
const cloneQueue = new CloneQueue({ db, root, tree });
const app = createApp({ mgr, db, cfg: DEFAULT_CONFIG, root, tree,
  listener: { open: async () => {}, notify: () => {}, clipboard: async () => ({ status: 204, contentType: null, body: new Uint8Array() }), openUrl: async () => {}, proxyBridge: async () => {}, dbRequest: async () => {}, sshApproval: async () => {} }, notify: () => {}, stats: () => ({}), cloneQueue,
  configRepo: { read: () => DEFAULT_CONFIG, write: async () => {} },
  backup: { build: async () => "/tmp/x", restore: async () => {} } });
const server = Bun.serve({ port: 0, fetch: app.fetch });
afterAll(() => server.stop(true));

// Bun.spawnSync would deadlock here: it blocks the parent's JS thread
// synchronously, and the in-process Bun.serve server above needs that same
// thread free to answer the child's HTTP request. Bun.spawn (async) lets the
// event loop keep servicing the server while we await the child's exit.
async function runCli(...args: string[]) {
  const p = Bun.spawn(["bun", "cli/src/main.ts", ...args], {
    cwd: join(import.meta.dir, "..", ".."),
    env: { ...process.env, DEV_DEVD_URL: `http://127.0.0.1:${server.port}`, DEV_SSH_HOST: "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { code, out: stdout + stderr };
}

async function runCliAgainst(port: number | undefined, ...args: string[]) {
  const p = Bun.spawn(["bun", "cli/src/main.ts", ...args], {
    cwd: join(import.meta.dir, "..", ".."),
    env: { ...process.env, DEV_DEVD_URL: `http://127.0.0.1:${port}`, DEV_SSH_HOST: "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { code, out: stdout + stderr };
}

// Explicit stdin: "ignore" forces a deterministic non-TTY child regardless of what
// this test happens to inherit — a bare `dev` here must fail closed via requireTty()
// instead of rendering a clack select() that blocks forever on a closed stdin.
async function runCliNoTty(...args: string[]) {
  const p = Bun.spawn(["bun", "cli/src/main.ts", ...args], {
    cwd: join(import.meta.dir, "..", ".."),
    env: { ...process.env, DEV_DEVD_URL: `http://127.0.0.1:${server.port}`, DEV_SSH_HOST: "" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { code, out: stdout + stderr };
}

test("dev ls prints empty state in English", async () => {
  const r = await runCli("ls");
  expect(r.code).toBe(0);
  expect(r.out).toContain("No sessions.");
});

test("dev _targets lists project/repo for completions", async () => {
  const r = await runCli("_targets");
  expect(r.code).toBe(0);
  expect(r.out.trim()).toBe("shop/cms");
});

test("unknown flag prints usage and exits 2", async () => {
  // A bare word like "nonsense" is a legitimate `dev <repo>` target attempt (routed
  // to the interactive picker, see pickAndOpen), not an unknown command — so it
  // does not print usage. An unrecognized flag has no such interpretation and
  // must fail closed with usage.
  const r = await runCli("--nonsense");
  expect(r.code).toBe(2);
  expect(r.out).toContain("Usage");
});

test("dev -n <target> is no longer a flag — USAGE and code 2, wherever it stands", async () => {
  // `-n` (another window over the SAME files) was removed: another session is created from the
  // menu and is its own container. If the flag silently fell through (as a no-op or as a target),
  // the user would think it still works.
  const leading = await runCli("-n", "shop/cms");
  expect(leading.code).toBe(2);
  expect(leading.out).toContain("Usage");
  const trailing = await runCli("shop/cms", "-n");
  expect(trailing.code).toBe(2);
  expect(trailing.out).toContain("Usage");
}, 15_000);

test("USAGE does not advertise the nonexistent -n flag", async () => {
  const r = await runCli("--nonsense");
  expect(r.out).toContain("Usage");
  expect(r.out).not.toContain("-n ");
  expect(r.out).not.toContain("-n =");
});

test("dev <unresolvable word> fails closed with an English error instead of prompting", async () => {
  // "nonsense" resolves to 0 targets and isn't a running claudeSolo session, so
  // pickAndOpen must error out before ever reaching a clack prompt — this process
  // has no TTY, so an actual prompt would hang the test on stdin.
  const r = await runCli("nonsense");
  expect(r.code).toBe(1);
  expect(r.out).toContain("not found");
});

test("dev --agent <unknown> fails closed with exit 2, doesn't silently fall back", async () => {
  const r = await runCli("--agent", "gpt", "shop/cms");
  expect(r.code).toBe(2);
  expect(r.out).toContain("unknown agent");
  expect(r.out).toContain("gpt");
});

test("dev --agent (no value) fails closed with exit 2", async () => {
  const r = await runCli("--agent");
  expect(r.code).toBe(2);
  expect(r.out).toContain("unknown agent");
});

test("dev --agent grok <word> strips the VALUE too — 'grok' never becomes the target", async () => {
  // Regression: a naive filter that only drops the flag itself (not its value)
  // would leave "grok" in argv, and it'd be resolved as the query instead of
  // "nonsense" — a repo named "grok" doesn't exist either, but the error message
  // would name the wrong thing.
  const r = await runCli("--agent", "grok", "nonsense");
  expect(r.code).toBe(1);
  expect(r.out).toContain("nonsense");
  expect(r.out).not.toContain('"grok"');
});

test("dev clone <nonexistent name> fails closed with an English error instead of no-op'ing", async () => {
  // Spec §8: `dev clone <name>` must resolve against the tree (folder OR project),
  // not just folder. A name matching neither used to silently no-op ("Done: 0/0");
  // it must now error out before ever calling POST /api/clone.
  const r = await runCli("clone", "nonexistent");
  expect(r.code).toBe(1);
  expect(r.out).toContain("is not a folder or a project");
});

test("dev backup downloads the file devd builds and dev restore posts it back through", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cli-e2e-backup-"));
  const backupFile = join(dir, "backup.tgz");
  writeFileSync(backupFile, "backup-payload");
  let restoredContent: string | undefined;
  const backupApp = createApp({
    mgr, db, cfg: DEFAULT_CONFIG, root, tree,
    listener: { open: async () => {}, notify: () => {}, clipboard: async () => ({ status: 204, contentType: null, body: new Uint8Array() }), openUrl: async () => {}, proxyBridge: async () => {}, dbRequest: async () => {}, sshApproval: async () => {} }, notify: () => {}, stats: () => ({}), cloneQueue,
    configRepo: { read: () => DEFAULT_CONFIG, write: async () => {} },
    backup: { build: async () => backupFile, restore: async (p: string) => { restoredContent = readFileSync(p, "utf8"); } },
  });
  const backupServer = Bun.serve({ port: 0, fetch: backupApp.fetch });
  try {
    const out = join(dir, "out.tgz");
    const r1 = await runCliAgainst(backupServer.port, "backup", out);
    expect(r1.code).toBe(0);
    expect(r1.out).toContain("Backup saved");
    expect(readFileSync(out, "utf8")).toBe("backup-payload");

    const r2 = await runCliAgainst(backupServer.port, "restore", out);
    expect(r2.code).toBe(0);
    expect(r2.out).toContain("Restored");
    expect(restoredContent).toBe("backup-payload");
  } finally {
    backupServer.stop(true);
  }
});

test("dev restore <missing file> fails closed with an English error instead of posting", async () => {
  const r = await runCli("restore", "/nonexistent/path/x.tgz");
  expect(r.code).toBe(1);
  expect(r.out).toContain("does not exist");
});

test("bare dev with no TTY fails closed instead of hanging on a clack prompt", async () => {
  // Bare `dev` now opens the session manager (sessionManager), whose first step is
  // requireTty() — without a TTY it must return 1 and print an error, never call clack
  // select() against /dev/null (otherwise it would hang forever).
  const r = await runCliNoTty();
  expect(r.code).toBe(1);
  expect(r.out).toContain("requires a terminal");
}, 10_000);

test("dev local with no TTY fails closed instead of hanging on a clack prompt", async () => {
  // `local` is purely interactive (harness picker + confirm) — without a TTY it must fail
  // via requireTty(), not fall through to the default branch as the query "local".
  const r = await runCliNoTty("local");
  expect(r.code).toBe(1);
  expect(r.out).toContain("requires a terminal");
}, 10_000);

test("attach: no target → usage (2)", async () => {
  const r = await runCli("attach");
  expect(r.code).toBe(2);
});

test("attach: unknown session → error", async () => {
  const r = await runCli("attach", "missing/nowhere");
  expect(r.code).toBe(1);
  expect(r.out).toContain("doesn't exist");
});

test("attach: stopped session → English error, no exec", async () => {
  insertSession(db, {
    id: "dev-att-stop", folder: "acme", project: "att", repo: "stop", container: "dev-att-stop",
    port_base: 40980, status: "stopped", solo: 0, created_at: 1, last_active_at: 1, important: 0,
  });
  const r = await runCli("attach", "att/stop");
  expect(r.code).toBe(1);
  expect(r.out).toContain("isn't running");
});

// I2 from the review: `project/repo` can now match several sessions and `find()` silently took
// the oldest. In automation (no TTY) a choice cannot be offered, so it has to speak up — taking
// the first one means, after C1, deleting the files of a session nobody meant.
test("dev end <project/repo> with two sessions and no TTY fails loudly and lists the ids", async () => {
  for (const [id, created] of [["dev-dup-web", 10], ["dev-dup-web-2", 11]] as const) {
    insertSession(db, {
      id, folder: "acme", project: "dup", repo: "web", container: id,
      port_base: 40990 + created, status: "stopped", solo: 0, created_at: created, last_active_at: created, important: 0,
    });
  }
  const r = await runCliNoTty("end", "dup/web");
  expect(r.code).toBe(1);
  expect(r.out).toContain("dev-dup-web");
  expect(r.out).toContain("dev-dup-web-2");
  // Nothing was ended: both sessions are still in the DB.
  expect(getSession(db, "dev-dup-web")).not.toBeNull();
  expect(getSession(db, "dev-dup-web-2")).not.toBeNull();
});

// An exact id must stay unambiguous even where `project/repo` is ambiguous —
// a notification click runs `dev attach <id>` and must not start offering anything.
test("a query for an exact id with two sessions of the repo does not change behavior", async () => {
  const r = await runCliNoTty("attach", "dev-dup-web-2");
  expect(r.code).toBe(1);
  expect(r.out).toContain("isn't running");   // got as far as the state check, not to the ambiguity
  expect(r.out).not.toContain("matches");
});
