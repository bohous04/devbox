import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const SHIM = join(import.meta.dir, "..", "..", "mac", "claude-shim.sh");

// A developer mac almost certainly has a real `claude` on PATH (this machine does
// too) — so "nothing is found" tests must not rely on the inherited PATH, otherwise
// they would behave differently depending on what each person has installed. `/usr/bin:/bin`
// has bash/sed/curl/git/basename/dirname, but nothing ever installs `claude` there.
const NO_CLAUDE_PATH = "/usr/bin:/bin";

// Fake "claude": prints its arguments and selected env, then exits with the chosen code.
function stubClaude(exitCode = 0): string {
  const dir = mkdtempSync(join(tmpdir(), "claude-stub-"));
  const p = join(dir, "claude");
  writeFileSync(p, `#!/usr/bin/env bash
echo "ARGS:$*"
echo "CFG:\${CLAUDE_CONFIG_DIR:-}"
echo "OTEL:\${OTEL_RESOURCE_ATTRIBUTES:-}"
exit ${exitCode}
`);
  chmodSync(p, 0o755);
  return p;
}

function poolDir(ids: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "claude-pool-"));
  for (const id of ids) mkdirSync(join(dir, id), { recursive: true });
  return dir;
}

// The environment is inherited on purpose (the shim needs PATH, HOME, git), but variables the
// shim itself SETS or READS as its configuration must be cleared from the surroundings —
// otherwise the tests measure not the shim but the environment of whoever ran them. Concretely:
// Claude Code always has CLAUDE_CONFIG_DIR set, so `expect(r.cfg).toBe("")` failed and
// everyone had to remember `env -u CLAUDE_CONFIG_DIR bun run ci`. An inherited DEVD_URL would
// also send the test to the real devd instead of the stub server.
const SHIM_OWNED_ENV = ["CLAUDE_CONFIG_DIR", "OTEL_RESOURCE_ATTRIBUTES", "DEVD_URL", "CLAUDE_POOL_REAL", "CLAUDE_POOL_DIR"];

async function runShim(env: Record<string, string>, args: string[] = []) {
  const base: Record<string, string | undefined> = { ...process.env };
  for (const k of SHIM_OWNED_ENV) delete base[k];
  const p = Bun.spawn(["bash", SHIM, ...args], {
    env: { ...base, ...env },
    cwd: mkdtempSync(join(tmpdir(), "shim-cwd-")),
    stdout: "pipe", stderr: "ignore",
  });
  const out = await new Response(p.stdout).text();
  const code = await p.exited;
  const line = (k: string) => out.split("\n").find((l) => l.startsWith(`${k}:`))?.slice(k.length + 1) ?? "";
  return { out, code, args: line("ARGS"), cfg: line("CFG"), otel: line("OTEL") };
}

test("mac shim: with devd running it sets CLAUDE_CONFIG_DIR and OTel attributes", async () => {
  const pool = poolDir(["primary"]);
  const srv = Bun.serve({
    port: 0,
    fetch: (req) => {
      const u = new URL(req.url);
      expect(u.pathname).toBe("/api/accounts/lease");
      expect(u.searchParams.get("client")).toBe("mac");
      return Response.json({ accountId: "primary", label: "a@x.cz", exhausted: false });
    },
  });
  try {
    const r = await runShim({
      DEVD_URL: `http://127.0.0.1:${srv.port}`, CLAUDE_POOL_REAL: stubClaude(), CLAUDE_POOL_DIR: pool,
    }, ["--version"]);
    expect(r.cfg).toBe(join(pool, "primary"));
    expect(r.args).toBe("--version");
    expect(r.otel).toContain("devbox.host=mac");
    expect(r.otel).toContain("devbox.account=a@x.cz");
    expect(r.otel).toContain("project=");
    expect(r.code).toBe(0);
  } finally { srv.stop(true); }
});

test("mac shim: with devd down it runs claude WITHOUT a config dir and returns its exit code", async () => {
  const r = await runShim({
    DEVD_URL: "http://127.0.0.1:1", CLAUDE_POOL_REAL: stubClaude(7), CLAUDE_POOL_DIR: poolDir(["primary"]),
  }, ["chat", "-p", "ahoj"]);
  expect(r.cfg).toBe("");
  expect(r.args).toBe("chat -p ahoj");
  expect(r.code).toBe(7);
  // even during an outage the machine attribution in stats is not lost
  expect(r.otel).toContain("devbox.host=mac");
});

test("mac shim: account without a profile on disk → no injection (better Keychain than broken)", async () => {
  const srv = Bun.serve({ port: 0, fetch: () => Response.json({ accountId: "primary", label: "a", exhausted: false }) });
  try {
    const r = await runShim({
      DEVD_URL: `http://127.0.0.1:${srv.port}`, CLAUDE_POOL_REAL: stubClaude(), CLAUDE_POOL_DIR: poolDir([]),
    });
    expect(r.cfg).toBe("");
    expect(r.code).toBe(0);
  } finally { srv.stop(true); }
});

test("mac shim: accountId null → no injection", async () => {
  const srv = Bun.serve({ port: 0, fetch: () => Response.json({ accountId: null, label: null, exhausted: true }) });
  try {
    const r = await runShim({
      DEVD_URL: `http://127.0.0.1:${srv.port}`, CLAUDE_POOL_REAL: stubClaude(), CLAUDE_POOL_DIR: poolDir(["primary"]),
    });
    expect(r.cfg).toBe("");
  } finally { srv.stop(true); }
});

test("mac shim: missing real binary and nothing on PATH exits non-zero with a message, not silently", async () => {
  const r = await runShim({
    DEVD_URL: "http://127.0.0.1:1", CLAUDE_POOL_REAL: "/neexistuje/claude", CLAUDE_POOL_DIR: poolDir([]),
    PATH: NO_CLAUDE_PATH,
  });
  expect(r.code).not.toBe(0);
});

test("mac shim: nonexistent REAL_CLAUDE but claude on PATH (without the shim directory) → the one on PATH runs", async () => {
  const stubDir = dirname(stubClaude(0));
  const r = await runShim({
    DEVD_URL: "http://127.0.0.1:1", CLAUDE_POOL_REAL: "/neexistuje/claude", CLAUDE_POOL_DIR: poolDir([]),
    // The shim directory (mac/) is deliberately NOT on this PATH — if it were and the
    // lookup found itself, that would be exactly the recursion trap it must avoid.
    PATH: `${stubDir}:${NO_CLAUDE_PATH}`,
  }, ["--version"]);
  expect(r.args).toBe("--version");
  expect(r.code).toBe(0);
});

test("mac shim: POOL_DIR does not exist at all → devd is not called (the profile has nowhere to mount anyway)", async () => {
  let called = false;
  const srv = Bun.serve({
    port: 0,
    fetch: () => { called = true; return Response.json({ accountId: "primary", label: "a", exhausted: false }); },
  });
  try {
    const missingPool = join(mkdtempSync(join(tmpdir(), "claude-pool-parent-")), "accounts");
    const r = await runShim({
      DEVD_URL: `http://127.0.0.1:${srv.port}`, CLAUDE_POOL_REAL: stubClaude(), CLAUDE_POOL_DIR: missingPool,
    });
    expect(called).toBe(false);
    expect(r.cfg).toBe("");
    expect(r.code).toBe(0);
  } finally { srv.stop(true); }
});

test("mac shim: a comma in the label does not break the OTEL_RESOURCE_ATTRIBUTES format (k=v,k=v)", async () => {
  const pool = poolDir(["primary"]);
  const srv = Bun.serve({
    port: 0,
    fetch: () => Response.json({ accountId: "primary", label: "a@x.cz (Firma, s.r.o.)", exhausted: false }),
  });
  try {
    const r = await runShim({
      DEVD_URL: `http://127.0.0.1:${srv.port}`, CLAUDE_POOL_REAL: stubClaude(), CLAUDE_POOL_DIR: pool,
    });
    // An intact label => exactly 3 pairs (devbox.host, project, devbox.account).
    // An unescaped comma in the label would add a bogus 4th "pair" without a key.
    expect(r.otel.split(",")).toHaveLength(3);
    expect(r.otel).toContain("devbox.account=a@x.cz (Firma");
  } finally { srv.stop(true); }
});

test("mac shim: the script ends with exec, not a plain call (TTY, signals, exit code)", async () => {
  const src = await Bun.file(SHIM).text();
  expect(src.trimEnd().endsWith('exec "$REAL_CLAUDE" "$@"')).toBe(true);
  expect(src).toContain("--max-time 1.5");
});
