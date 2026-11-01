import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redactArgv, run, timeoutFor, TIMEOUTS } from "../src/proc";

test("run: the event loop does NOT stall during a subprocess (the timer fires before sleep ends)", async () => {
  const order: string[] = [];
  const timer = new Promise<void>((r) => setTimeout(() => { order.push("timer"); r(); }, 100));
  const proc = run(["sleep", "1"], { timeoutMs: 5_000 }).then(() => { order.push("sleep"); });
  await Promise.all([timer, proc]);
  expect(order).toEqual(["timer", "sleep"]);
});

test("run: timeout kills the process and returns timedOut (within 2 s, not after 10 s)", async () => {
  const t0 = Date.now();
  const r = await run(["sleep", "10"], { timeoutMs: 200 });
  expect(r.timedOut).toBe(true);
  // 2 s is still miles away from `sleep 10` — it just does not break under CI load.
  expect(Date.now() - t0).toBeLessThan(2_000);
});

test("run: stdin, env and cwd reach the child", async () => {
  const dir = mkdtempSync(join(tmpdir(), "proc-"));
  const r = await run(["sh", "-c", "cat; echo; echo $PROC_TEST_VAR; pwd"], { cwd: dir, env: { PROC_TEST_VAR: "hello" }, stdin: "input", timeoutMs: 5_000 });
  expect(r.code).toBe(0);
  const lines = r.stdout.trim().split("\n");
  expect(lines[0]).toBe("input");
  expect(lines[1]).toBe("hello");
  expect(lines[2].endsWith(dir.split("/").pop()!)).toBe(true);   // /private/var vs /var na macu
});

test("run: env is merged with process.env (PATH stays)", async () => {
  const r = await run(["sh", "-c", "echo $PATH"], { env: { X: "1" }, timeoutMs: 5_000 });
  expect(r.stdout.trim().length).toBeGreaterThan(0);
});

test("run: unsetEnv removes inherited and explicit variables only from the child, while an empty value remains set", async () => {
  const previous = process.env.PROC_TEST_REMOVE;
  process.env.PROC_TEST_REMOVE = "parent-value";
  try {
    const script = 'printf "%s|%s|%s" "${PROC_TEST_REMOVE+x}" "${PROC_TEST_KEEP:-}" "${PATH:+present}"';
    const empty = await run(["sh", "-c", script], { env: { PROC_TEST_REMOVE: "", PROC_TEST_KEEP: "kept" }, timeoutMs: 5000 });
    expect(empty.code).toBe(0); expect(empty.stdout).toBe("x|kept|present");
    const removed = await run(["sh", "-c", script], { env: { PROC_TEST_REMOVE: "explicit-value", PROC_TEST_KEEP: "kept" }, unsetEnv: ["PROC_TEST_REMOVE"], timeoutMs: 5000 });
    expect(removed.code).toBe(0); expect(removed.stdout).toBe("|kept|present");
    expect(process.env.PROC_TEST_REMOVE).toBe("parent-value");
    const next = await run(["sh", "-c", 'printf "%s" "$PROC_TEST_REMOVE"'], { timeoutMs: 5000 });
    expect(next.stdout).toBe("parent-value");
  } finally {
    if (previous === undefined) delete process.env.PROC_TEST_REMOVE;
    else process.env.PROC_TEST_REMOVE = previous;
  }
});

test("run: missing binary → code 127, no exception", async () => {
  const r = await run(["/nonexistent/binarka-xyz"], { timeoutMs: 5_000 });
  expect(r.code).toBe(127);
  expect(r.timedOut).toBe(false);
  expect(r.stderr.length).toBeGreaterThan(0);
});

test("run: empty argv is a programmer error", async () => {
  await expect(run([], { timeoutMs: 1_000 })).rejects.toThrow(/empty argv/);
});

test("timeoutFor: default value from the group, env overrides it", () => {
  expect(timeoutFor("DOCKER_QUERY")).toBe(TIMEOUTS.DOCKER_QUERY);
  process.env.DEVD_TIMEOUT_DOCKER_QUERY_MS = "1234";
  try { expect(timeoutFor("DOCKER_QUERY")).toBe(1234); }
  finally { delete process.env.DEVD_TIMEOUT_DOCKER_QUERY_MS; }
  process.env.DEVD_TIMEOUT_DOCKER_QUERY_MS = "nesmysl";
  try { expect(timeoutFor("DOCKER_QUERY")).toBe(TIMEOUTS.DOCKER_QUERY); }
  finally { delete process.env.DEVD_TIMEOUT_DOCKER_QUERY_MS; }
});

test("run: a slow command logs a warning with argv", async () => {
  const warned: string[] = [];
  const orig = console.warn;
  console.warn = (m: string) => { warned.push(String(m)); };
  try {
    process.env.DEVD_SLOW_WARN_MS = "50";
    await run(["sleep", "0.2"], { timeoutMs: 5_000 });
  } finally { console.warn = orig; delete process.env.DEVD_SLOW_WARN_MS; }
  expect(warned.some((w) => w.includes("sleep 0.2"))).toBe(true);
});

test("redactArgv: hides a variable value by name (KEY/TOKEN/…), not by position after -e", () => {
  expect(redactArgv(["docker", "run", "-e", "DEVD_UPSTREAM_KEY=abc", "-e", "DEVD_AGENT=claude", "img"]))
    .toEqual(["docker", "run", "-e", "DEVD_UPSTREAM_KEY=***", "-e", "DEVD_AGENT=claude", "img"]);
  expect(redactArgv(["env", "GITHUB_TOKEN=x"])).toEqual(["env", "GITHUB_TOKEN=***"]); // a bare element, no -e before it
  expect(redactArgv(["git", "clone", "https://x"])).toEqual(["git", "clone", "https://x"]);
});

test("redactArgv: masks only a whole _-separated name component, not any substring match", () => {
  // SHOULD be masked — the word is a whole name component (at the start/end/middle, separated by `_`).
  expect(redactArgv(["env", "DEVD_UPSTREAM_KEY=abc"])).toEqual(["env", "DEVD_UPSTREAM_KEY=***"]);
  expect(redactArgv(["env", "GITHUB_TOKEN=x"])).toEqual(["env", "GITHUB_TOKEN=***"]);
  expect(redactArgv(["env", "OP_SERVICE_ACCOUNT_TOKEN=x"])).toEqual(["env", "OP_SERVICE_ACCOUNT_TOKEN=***"]);
  expect(redactArgv(["env", "ANTHROPIC_AUTH_TOKEN=x"])).toEqual(["env", "ANTHROPIC_AUTH_TOKEN=***"]);
  expect(redactArgv(["env", "apikey=x"])).toEqual(["env", "apikey=***"]);
  expect(redactArgv(["env", "Password=x"])).toEqual(["env", "Password=***"]);
  // Should NOT be masked — the secret word is only a substring of another name component.
  expect(redactArgv(["ssh", "-o", "StrictHostKeyChecking=no"])).toEqual(["ssh", "-o", "StrictHostKeyChecking=no"]);
  expect(redactArgv(["env", "monkey=x"])).toEqual(["env", "monkey=x"]);
  expect(redactArgv(["env", "bypass=1"])).toEqual(["env", "bypass=1"]);
  expect(redactArgv(["env", "DEVD_AGENT=claude"])).toEqual(["env", "DEVD_AGENT=claude"]);
});

test("redactArgv: also masks the plural of a name component (TOKENS/SECRETS/KEYS)", () => {
  // SHOULD be masked — the secret word in plural is still a whole component.
  expect(redactArgv(["env", "DEVD_GITEA_TOKENS=x"])).toEqual(["env", "DEVD_GITEA_TOKENS=***"]);
  expect(redactArgv(["env", "AWS_SECRET_ACCESS_KEYS=x"])).toEqual(["env", "AWS_SECRET_ACCESS_KEYS=***"]);
  expect(redactArgv(["env", "MY_KEYS=x"])).toEqual(["env", "MY_KEYS=***"]);
  // Still should NOT be masked — "keys" is only a substring of another component here.
  expect(redactArgv(["ssh", "-o", "StrictHostKeyChecking=no"])).toEqual(["ssh", "-o", "StrictHostKeyChecking=no"]);
  expect(redactArgv(["env", "monkeys=x"])).toEqual(["env", "monkeys=x"]);
});

// git clone may get a URL with a token (giteaAuthEnv/gitClone), so userinfo is masked too.
test("redactArgv: hides userinfo in a URL (user:pass@ and a bare token@)", () => {
  expect(redactArgv(["git", "clone", "https://devbox:abc123@gitea.example/x.git", "dest"]))
    .toEqual(["git", "clone", "https://***@gitea.example/x.git", "dest"]);
  expect(redactArgv(["git", "clone", "https://ghp_supersecrettoken@github.com/o/r.git", "dest"]))
    .toEqual(["git", "clone", "https://***@github.com/o/r.git", "dest"]);
});

test("redactArgv: leaves a plain URL without userinfo unchanged", () => {
  expect(redactArgv(["git", "clone", "https://github.com/x/y.git"]))
    .toEqual(["git", "clone", "https://github.com/x/y.git"]);
});

test("run: a slow subprocess with a secret in argv (-e KEY=…, as with docker run) does not log it in plaintext", async () => {
  const warned: string[] = [];
  const orig = console.warn;
  console.warn = (m: string) => { warned.push(String(m)); };
  try {
    process.env.DEVD_SLOW_WARN_MS = "50";
    // Extra argv after `--` shows up in `bash -c "sleep 0.2"` only as $0/$1…,
    // the script does not read them — so the command still just sleeps 0.2 s, but `cmd.join(" ")`
    // in the log has the same shape as `docker run -e NAME=value …`.
    await run(["bash", "-c", "sleep 0.2", "--", "-e", "DEVD_UPSTREAM_KEY=shh"], { timeoutMs: 5_000 });
  } finally { console.warn = orig; delete process.env.DEVD_SLOW_WARN_MS; }
  expect(warned.some((w) => w.includes("shh"))).toBe(false);
  expect(warned.some((w) => w.includes("DEVD_UPSTREAM_KEY=***"))).toBe(true);
});

test("run: without an explicit env it sees the LIVE process.env, not a snapshot from Bun startup", async () => {
  process.env.PROC_TEST_LIVE = "x";
  try {
    const r = await run(["sh", "-c", "echo $PROC_TEST_LIVE"], { timeoutMs: 5_000 });
    expect(r.stdout.trim()).toBe("x");
  } finally { delete process.env.PROC_TEST_LIVE; }
});

test("run: timeout does not wait for an orphan (a forked grandchild holds the pipes, run() still returns fast)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "proc-orphan-"));
  const script = join(dir, "fake");
  // `sleep 5` is NOT the script's last command here (case continues with `exit 0`), so
  // bash forks it rather than exec-ing it — SIGKILL kills only bash, the forked sleep survives as
  // an orphan and keeps the pipes open.
  writeFileSync(script, `#!/usr/bin/env bash\ncase "$1" in x) sleep 5 ;; esac; exit 0\n`);
  chmodSync(script, 0o755);
  const t0 = Date.now();
  const r = await run([script, "x"], { timeoutMs: 200 });
  expect(r.timedOut).toBe(true);
  expect(Date.now() - t0).toBeLessThan(1_000);
});

test("run: a background orphan does not block run() even WITHOUT a timeout (the child exits normally)", async () => {
  const t0 = Date.now();
  const r = await run(["bash", "-c", "sleep 5 & exit 0"], { timeoutMs: 300 });
  // 2 s is a safer threshold under CI load, and still far enough below the background `sleep 5`
  // for the test to keep proving that run() does not wait for the orphan.
  expect(Date.now() - t0).toBeLessThan(2_000);
  expect(r.timedOut).toBe(false);
  expect(r.code).toBe(0);
});
