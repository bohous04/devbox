import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const IMAGE = join(import.meta.dir, "..", "..", "image");

async function runShim(env: Record<string, string>): Promise<{ out: string; code: number }> {
  const p = Bun.spawn(["bash", join(IMAGE, "account-lease.sh")], {
    env: { ...process.env, DEVD_URL: "", DEVD_SESSION_ID: "", ...env },
    stdout: "pipe", stderr: "ignore",
  });
  const out = await new Response(p.stdout).text();
  return { out: out.trim(), code: await p.exited };
}

function profileRoot(ids: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "acct-profiles-"));
  for (const id of ids) mkdirSync(join(dir, id));
  return dir;
}

test("account-lease: with devd running prints the profile path", async () => {
  const root = profileRoot(["primary"]);
  const srv = Bun.serve({
    port: 0,
    fetch: (req) => {
      const u = new URL(req.url);
      expect(u.pathname).toBe("/api/accounts/lease");
      expect(u.searchParams.get("client")).toBe("devbox");
      expect(u.searchParams.get("session")).toBe("dev-x-y");
      return Response.json({ accountId: "primary", label: "a@x.cz", exhausted: false });
    },
  });
  try {
    const r = await runShim({
      DEVD_URL: `http://127.0.0.1:${srv.port}`, DEVD_SESSION_ID: "dev-x-y", ACCOUNT_PROFILE_ROOT: root,
    });
    expect(r.out).toBe(join(root, "primary"));
    expect(r.code).toBe(0);
  } finally { srv.stop(true); }
});

test("account-lease: an account without a profile in the container → nothing (old container without the mount)", async () => {
  const root = profileRoot([]);   // the volume is not mounted yet
  const srv = Bun.serve({ port: 0, fetch: () => Response.json({ accountId: "primary", label: "a", exhausted: false }) });
  try {
    const r = await runShim({ DEVD_URL: `http://127.0.0.1:${srv.port}`, DEVD_SESSION_ID: "dev-x-y", ACCOUNT_PROFILE_ROOT: root });
    expect(r.out).toBe("");
    expect(r.code).toBe(0);
  } finally { srv.stop(true); }
});

test("account-lease: accountId null → nothing", async () => {
  const root = profileRoot(["primary"]);
  const srv = Bun.serve({ port: 0, fetch: () => Response.json({ accountId: null, label: null, exhausted: true }) });
  try {
    const r = await runShim({ DEVD_URL: `http://127.0.0.1:${srv.port}`, DEVD_SESSION_ID: "dev-x-y", ACCOUNT_PROFILE_ROOT: root });
    expect(r.out).toBe("");
  } finally { srv.stop(true); }
});

test("account-lease: dead devd → nothing, exit 0 (fail-open, start is never blocked)", async () => {
  const root = profileRoot(["primary"]);
  const r = await runShim({
    DEVD_URL: "http://127.0.0.1:1", DEVD_SESSION_ID: "dev-x-y", ACCOUNT_PROFILE_ROOT: root,
  });
  expect(r.out).toBe("");
  expect(r.code).toBe(0);
});

// Incident 3 Sep 2026: devd has a single thread and calls docker/git/op via Bun.spawnSync
// (docker.ts → git.ts `sh`, op.ts), so recreating a neighbouring container blocks
// the whole event loop for seconds. The lease of a session that is just starting hangs in the queue,
// curl with --max-time 2 gives up and the script fails open — the session is born on the shared
// profile while devd writes the lease as soon as it unblocks (in the DB +4 s after the recreate,
// exactly in the second the next recreate finished). One attempt is therefore not enough;
// it retries until devd answers or the attempts run out.
test("account-lease: devd blocked on the first attempt → tries again and prints the profile", async () => {
  const root = profileRoot(["primary"]);
  let calls = 0;
  const srv = Bun.serve({
    port: 0,
    fetch: async () => {
      calls++;
      if (calls === 1) await Bun.sleep(1500);   // the devd event loop "stalls" longer than the timeout
      return Response.json({ accountId: "primary", label: "a@x.cz", exhausted: false });
    },
  });
  try {
    const r = await runShim({
      DEVD_URL: `http://127.0.0.1:${srv.port}`, DEVD_SESSION_ID: "dev-x-y", ACCOUNT_PROFILE_ROOT: root,
      ACCOUNT_LEASE_TIMEOUT: "0.5", ACCOUNT_LEASE_PAUSE: "0.1", ACCOUNT_LEASE_TRIES: "3",
    });
    expect(r.out).toBe(join(root, "primary"));
    expect(r.code).toBe(0);
    expect(calls).toBe(2);
  } finally { srv.stop(true); }
});

// Fail-open stays: when devd does not answer even after the last attempt, nothing and zero.
test("account-lease: devd hangs on all attempts → nothing, exit 0, the number of attempts is limited", async () => {
  const root = profileRoot(["primary"]);
  let calls = 0;
  const srv = Bun.serve({
    port: 0,
    fetch: async () => { calls++; await Bun.sleep(1500); return Response.json({ accountId: "primary" }); },
  });
  try {
    const r = await runShim({
      DEVD_URL: `http://127.0.0.1:${srv.port}`, DEVD_SESSION_ID: "dev-x-y", ACCOUNT_PROFILE_ROOT: root,
      ACCOUNT_LEASE_TIMEOUT: "0.3", ACCOUNT_LEASE_PAUSE: "0.1", ACCOUNT_LEASE_TRIES: "2",
    });
    expect(r.out).toBe("");
    expect(r.code).toBe(0);
    expect(calls).toBe(2);
  } finally { srv.stop(true); }
});

test("account-lease: without DEVD_URL or DEVD_SESSION_ID it does not even ask", async () => {
  const root = profileRoot(["primary"]);
  expect((await runShim({ ACCOUNT_PROFILE_ROOT: root, DEVD_SESSION_ID: "dev-x-y" })).out).toBe("");
  expect((await runShim({ ACCOUNT_PROFILE_ROOT: root, DEVD_URL: "http://127.0.0.1:1" })).out).toBe("");
});

// Fix from review round 1 (point 3): curl used to hit devd BEFORE checking that
// `ACCOUNT_PROFILE_ROOT` exists at all. `/home/dev/.claude-accounts` is not created in the Dockerfile
// — it exists only when at least one profile is mounted. Without this
// check BEFORE curl, a fresh container (zero accounts, deploy night after night) would for
// EVERY Claude session start needlessly call devd, devd would create a lease for it (the account
// looks busy even though the session uses no profile — inflating the poller
// cadence and the dashboard), and with a dead devd it would moreover add up to 2 s to the start
// that do not exist today (without the pool).
test("account-lease: ACCOUNT_PROFILE_ROOT does not exist at all → nothing, devd is not even asked", async () => {
  let called = false;
  const srv = Bun.serve({
    port: 0,
    fetch: () => { called = true; return Response.json({ accountId: "primary", label: "a", exhausted: false }); },
  });
  try {
    const missingRoot = join(mkdtempSync(join(tmpdir(), "acct-profiles-")), "does-not-exist");
    const r = await runShim({ DEVD_URL: `http://127.0.0.1:${srv.port}`, DEVD_SESSION_ID: "dev-x-y", ACCOUNT_PROFILE_ROOT: missingRoot });
    expect(r.out).toBe("");
    expect(r.code).toBe(0);
    expect(called).toBe(false);
  } finally { srv.stop(true); }
});

test("agent-launch: reaches for account-lease for claude, not for codex", async () => {
  const sh = await Bun.file(join(IMAGE, "agent-launch.sh")).text();
  expect(sh).toContain("account-lease");
  expect(sh).toContain("CLAUDE_CONFIG_DIR");
  // the pool is only for native Claude — claude-gpt/claude-grok go through a proxy,
  // Codex has its own mechanism (codex-home)
  expect(sh).toMatch(/if \[ "\$profile" = claude \]/);
});

// C1 (review round 4): the fail-open path (no lease) MUST NOT touch the variable at all.
// The Dockerfile sets `ENV CLAUDE_CONFIG_DIR=/home/dev/.claude` (where
// claude-home hangs) — that already IS the correct fallback. `unset` would not return it to this
// default, but would send Claude to `$HOME/.claude.json` instead of
// `$CLAUDE_CONFIG_DIR/.claude.json` (verified on claude 2.1.220) — i.e. into a profile
// without MCP servers, without an approved trust dialog, without onboarding, again on
// every recreate. Zero accounts (today's production state) is exactly this path.
test("agent-launch: fail-open (empty lease) leaves CLAUDE_CONFIG_DIR untouched (C1)", async () => {
  const sh = await Bun.file(join(IMAGE, "agent-launch.sh")).text();
  expect(sh).not.toContain("unset CLAUDE_CONFIG_DIR");
  expect(sh).toMatch(/if \[ -n "\$pool_dir" \]; then export CLAUDE_CONFIG_DIR="\$pool_dir"; fi/);
});

test("Dockerfile copies account-lease and the shared linker and gives them permissions", async () => {
  const df = await Bun.file(join(IMAGE, "Dockerfile")).text();
  expect(df).toContain("COPY account-lease.sh /usr/local/bin/account-lease");
  // without the linker in the image provisionProfile would fail with "command not found"
  expect(df).toContain("COPY link-shared-profile.sh /usr/local/bin/link-shared-profile");
  const chmodLines = df.split("\n").filter((l) => l.startsWith("RUN chmod 755"));
  expect(chmodLines.some((l) => l.includes("/usr/local/bin/account-lease"))).toBe(true);
  expect(chmodLines.some((l) => l.includes("/usr/local/bin/link-shared-profile"))).toBe(true);
});
