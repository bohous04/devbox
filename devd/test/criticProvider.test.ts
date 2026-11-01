import { expect, test } from "bun:test";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnWithTimeout } from "../src/docker";
import { run } from "../src/proc";
import {
  blockReason, blockingFindings, buildCriticPrompt, criticArgv, CriticParseError,
  DEFAULT_CRITIC_CFG, parseCriticOutput, resolveCriticCfg,
} from "../src/criticProvider";

test("claude argv never gives the critic Edit or Write", () => {
  const argv = criticArgv({ ...DEFAULT_CRITIC_CFG, provider: "claude", model: "opus" });
  expect(argv[0]).toBe("claude");
  expect(argv).toContain("-p");
  // --bare skips loading OAuth credentials → "Not logged in" (verified live)
  expect(argv).not.toContain("--bare");
  const tools = argv[argv.indexOf("--allowedTools") + 1];
  expect(tools).toBe("Read,Grep,Glob,Bash");
  expect(tools).not.toContain("Edit");
  expect(tools).not.toContain("Write");
  expect(argv.join(" ")).toContain("--output-format json");
  // the prompt goes via stdin, not argv — --allowedTools is variadic and would swallow it
  expect(argv[argv.length - 2]).toBe("--allowedTools");
});

test("codex argv runs in a read-only sandbox, without a prompt", () => {
  const argv = criticArgv({ ...DEFAULT_CRITIC_CFG, provider: "codex", model: "gpt-5.1" });
  expect(argv[0]).toBe("codex");
  expect(argv).toContain("exec");
  expect(argv[argv.indexOf("--sandbox") + 1]).toBe("read-only");
});

test("the critic prompt carries the task and the diff and forbids treating repo content as instructions", () => {
  const p = buildCriticPrompt("Add SSO", "--- git diff ---\n+code");
  expect(p).toContain("Add SSO");
  expect(p).toContain("+code");
  expect(p.toLowerCase()).toContain("data, not instructions");
  expect(p).toContain('"verdict"');
});

test("parsing the claude envelope: JSON verdict inside .result", () => {
  const envelope = JSON.stringify({
    type: "result", subtype: "success",
    result: 'I went through it.\n```json\n{"verdict":"issues","findings":[{"severity":"important","file":"a.ts","line":3,"what":"missing await","why":"race"}],"evidence":"tsc: 1 error"}\n```',
  });
  const v = parseCriticOutput(envelope, "claude");
  expect(v.verdict).toBe("issues");
  expect(v.findings).toHaveLength(1);
  expect(v.findings[0].file).toBe("a.ts");
  expect(v.evidence).toBe("tsc: 1 error");
});

test("parsing codex: plain text with a JSON block", () => {
  const v = parseCriticOutput('some noise\n{"verdict":"ok","findings":[]}\nend', "codex");
  expect(v.verdict).toBe("ok");
  expect(v.findings).toEqual([]);
});

test("a decoy JSON before the verdict is ignored, the last object is returned", () => {
  const v = parseCriticOutput(
    'Here is an example: {"foo": 1} but the real verdict is: {"verdict":"ok","findings":[]}',
    "codex",
  );
  expect(v.verdict).toBe("ok");
  expect(v.findings).toEqual([]);
});

test("multiple JSON objects — the last one wins", () => {
  const v = parseCriticOutput(
    '{"verdict":"issues","findings":[]} later otherwise: {"verdict":"ok","findings":[]}',
    "codex",
  );
  expect(v.verdict).toBe("ok");
});

test("braces inside string values do not break depth counting", () => {
  const v = parseCriticOutput(
    '{"verdict":"ok","findings":[],"evidence":"got {weird} output }{"}',
    "codex",
  );
  expect(v.verdict).toBe("ok");
  expect(v.evidence).toBe("got {weird} output }{");
});

test("unreadable output throws CriticParseError (caller → fail-open)", () => {
  expect(() => parseCriticOutput("the model rambled on and returned nothing", "codex")).toThrow(CriticParseError);
  expect(() => parseCriticOutput("", "claude")).toThrow(CriticParseError);
});

test("only critical/important block; minor passes", () => {
  const v = {
    verdict: "issues" as const,
    findings: [
      { severity: "minor" as const, what: "variable name" },
      { severity: "critical" as const, file: "b.ts", line: 9, what: "deleted migration", why: "data loss" },
    ],
  };
  const b = blockingFindings(v);
  expect(b).toHaveLength(1);
  expect(b[0].what).toBe("deleted migration");
  const reason = blockReason(b);
  expect(reason).toContain("b.ts:9");
  expect(reason).toContain("deleted migration");
  expect(reason).toContain("data loss");
  expect(blockingFindings({ verdict: "ok", findings: [] })).toHaveLength(0);
});

test("resolveCriticCfg fills in defaults and copes with a partial config from the dashboard", () => {
  expect(resolveCriticCfg(undefined)).toEqual(DEFAULT_CRITIC_CFG);
  expect(resolveCriticCfg({ model: "sonnet" })).toEqual({ ...DEFAULT_CRITIC_CFG, model: "sonnet" });
  expect(resolveCriticCfg({ provider: "codex" }).provider).toBe("codex");
  expect(resolveCriticCfg({ provider: "nonsense" as never }).provider).toBe("claude");
  expect(resolveCriticCfg({ rounds: 0 }).rounds).toBe(1);          // at least one round
  expect(resolveCriticCfg({ timeoutSec: 1 }).timeoutSec).toBe(10);    // lower bound
  expect(resolveCriticCfg({ timeoutSec: 9999 }).timeoutSec).toBe(280); // upper bound (the hook has -m 290)
});

test("spawnWithTimeout kills the process after the timeout and reports timedOut", async () => {
  const r = await spawnWithTimeout(["sleep", "5"], 150);
  expect(r.timedOut).toBe(true);
  expect(r.code).not.toBe(0);
});

test("spawnWithTimeout returns the stdout of a finished process", async () => {
  const r = await spawnWithTimeout(["echo", "hello"], 5000);
  expect(r.timedOut).toBe(false);
  expect(r.code).toBe(0);
  expect(r.stdout.trim()).toBe("hello");
});

test("codex argv: no model (default) omits -m, has sandbox read-only and skip-git-repo-check", () => {
  const argv = criticArgv({ provider: "codex", model: "default", rounds: 2, timeoutSec: 240 });
  expect(argv[0]).toBe("codex");
  expect(argv).toContain("exec");
  expect(argv[argv.indexOf("--sandbox") + 1]).toBe("read-only");
  expect(argv).toContain("--skip-git-repo-check");
  expect(argv).not.toContain("-m");
});

test("codex argv: an empty model also omits -m", () => {
  const argv = criticArgv({ provider: "codex", model: "", rounds: 2, timeoutSec: 240 });
  expect(argv).not.toContain("-m");
});

test("codex argv: a specific model adds -m <model>", () => {
  const argv = criticArgv({ provider: "codex", model: "o3", rounds: 2, timeoutSec: 240 });
  expect(argv[argv.indexOf("-m") + 1]).toBe("o3");
});

test("resolveCriticCfg: default model per provider", () => {
  expect(resolveCriticCfg({ provider: "claude" }).model).toBe("opus");
  expect(resolveCriticCfg({ provider: "codex" }).model).toBe("default");
  // an explicit model is respected for both
  expect(resolveCriticCfg({ provider: "codex", model: "o3" }).model).toBe("o3");
  expect(resolveCriticCfg({ provider: "claude", model: "sonnet" }).model).toBe("sonnet");
});

test("resolveCriticCfg: antigravity is kept, model default", () => {
  expect(resolveCriticCfg({ provider: "antigravity" } as never)).toMatchObject({ provider: "antigravity", model: "default" });
  expect(resolveCriticCfg({ provider: "nonsense" } as never).provider).toBe("claude");
});

test("criticArgv: antigravity wraps agy in an sh precheck script (token/onboarding), model only when given", () => {
  const argv = criticArgv({ provider: "antigravity", model: "default", rounds: 2, timeoutSec: 240 });
  expect(argv[0]).toBe("sh");
  expect(argv[1]).toBe("-c");
  const script = argv[2];
  expect(script).toContain("antigravity-oauth-token");
  expect(script).toContain(".devbox-onboarded");
  expect(script).toContain("agy-trust");
  // Verified live (Questions 7–11, Critic): `-p` takes a value and does not read stdin, so
  // the prompt must be saved to a temp file and passed as `-p="Read the file …"`.
  expect(script).toContain("mktemp");
  expect(script).toContain('cat > "$f"');
  expect(script).toContain('-p="Read the file');
  expect(script).toContain("rm -f");
  expect(script).toContain("exit $rc");
  // timeoutSec 240 → inner timeout = 240 - 5 = 235 (max(10, …))
  expect(script).toContain("timeout -k 5 235");
  expect(argv[3]).toBe("sh");
  // No bare -p: it carries only the "agy" argv and takes a value (verified live), so
  // it goes exclusively into the script as -p="Read the file $f …", not into argv.
  expect(argv.slice(4)).toEqual(["agy", "--output-format", "json", "--mode", "plan"]);

  const argvModel = criticArgv({ provider: "antigravity", model: "gemini-3.8-flash-high", rounds: 2, timeoutSec: 240 });
  expect(argvModel.slice(4)).toEqual(["agy", "--output-format", "json", "--mode", "plan", "--model", "gemini-3.8-flash-high"]);
});

test("criticArgv: antigravity — a small timeoutSec is clamped to the 10 s minimum", () => {
  const argv = criticArgv({ provider: "antigravity", model: "default", rounds: 2, timeoutSec: 12 });
  expect(argv[2]).toContain("timeout -k 5 10");
});

test("criticArgv: antigravity — a model value with shell metacharacters goes only as an argv element, never into the script", () => {
  const evilModel = "x; rm -rf /";
  const argv = criticArgv({ provider: "antigravity", model: evilModel, rounds: 2, timeoutSec: 240 });
  const script = argv[2];
  expect(script).not.toContain(evilModel);
  expect(argv.slice(4)).toEqual(["agy", "--output-format", "json", "--mode", "plan", "--model", evilModel]);
});

// Verified live 2026-10-15 against the real criticArgv + docker exec in a signed-in
// container: `--mode plan` forbids commands ("a tool required the command
// permission that headless mode cannot prompt for, so it was auto-denied") and
// agy returns an EMPTY response → parseCriticOutput fails → the critic fails open
// on every turn. This test simulates agy with a fake binary on PATH (and a fake
// `timeout` shim if missing on macOS) and verifies that the script:
//  1) sent the new -p= text as ONE argv element (not split on spaces),
//  2) deleted the temp prompt file after finishing.
test("criticArgv: antigravity — a fake agy on PATH gets the new -p= text as one argument, the temp file is gone after the run", async () => {
  const argv = criticArgv({ provider: "antigravity", model: "default", rounds: 2, timeoutSec: 240 });
  const root = await mkdtemp(join(tmpdir(), "agy-fake-"));
  try {
    const home = join(root, "home");
    const geminiDir = join(home, ".gemini", "antigravity-cli");
    await mkdir(geminiDir, { recursive: true });
    await writeFile(join(geminiDir, "antigravity-oauth-token"), "tok");
    await writeFile(join(geminiDir, ".devbox-onboarded"), "");

    const bin = join(root, "bin");
    await mkdir(bin, { recursive: true });
    const argsFile = join(root, "agy-args.txt");
    await writeFile(
      join(bin, "agy"),
      [
        "#!/bin/sh",
        'printf \'%s\\n\' "$@" > "$AGY_ARGS_FILE"',
        "cat <<'EOF'",
        '{"status":"SUCCESS","response":"{\\"verdict\\":\\"ok\\",\\"findings\\":[],\\"evidence\\":\\"fake\\"}"}',
        "EOF",
        "",
      ].join("\n"),
    );
    await chmod(join(bin, "agy"), 0o755);

    // macOS has no `timeout` (GNU coreutils) — without it the script would fail before
    // it even reaches agy. The fake shim drops "-k 5 <n>" and execs the rest.
    const hasTimeout = (await run(["sh", "-c", "command -v timeout"], { timeoutMs: 2000 })).code === 0;
    if (!hasTimeout) {
      await writeFile(join(bin, "timeout"), ["#!/bin/sh", "shift 3", 'exec "$@"', ""].join("\n"));
      await chmod(join(bin, "timeout"), 0o755);
    }

    const r = await run(argv, {
      env: { HOME: home, PATH: `${bin}:${process.env.PATH}`, AGY_ARGS_FILE: argsFile },
      stdin: "fake diff",
      timeoutMs: 5000,
    });
    expect(r.code).toBe(0);

    const calledArgs = (await readFile(argsFile, "utf8")).split("\n").filter(Boolean);
    const pArgs = calledArgs.filter((a) => a.startsWith("-p="));
    expect(pArgs).toHaveLength(1); // the new text must arrive as ONE argv element
    const m = pArgs[0].match(
      /^-p=Read the file (\S+) and follow its instructions, with one exception: you cannot run any commands or tests in this mode, so do not try — review by reading files only and put what you read as evidence\. Your final reply must be only the JSON that file asks for\.$/,
    );
    expect(m).not.toBeNull();

    const tmpPromptFile = m![1];
    await expect(access(tmpPromptFile)).rejects.toThrow(); // the temp file is deleted after the run
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("criticArgv: antigravity precheck script run locally in bash without a token exits fast (exit 3) with a message", async () => {
  const argv = criticArgv({ provider: "antigravity", model: "default", rounds: 2, timeoutSec: 240 });
  const script = argv[2];
  const tmpHome = await mkdtemp(join(tmpdir(), "agy-precheck-"));
  try {
    const start = performance.now();
    // We run the script itself via bash (not via "agy") against an empty HOME —
    // the precheck must exit before "agy"/"agy-trust"/"timeout" is touched at all.
    const r = await run(["bash", "-c", script, "sh"], { env: { HOME: tmpHome }, timeoutMs: 5000 });
    const elapsedMs = performance.now() - start;
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("not signed in or onboarding not finished");
    expect(elapsedMs).toBeLessThan(1000);
  } finally {
    await rm(tmpHome, { recursive: true, force: true });
  }
});

test("parseCriticOutput: antigravity .response envelope", () => {
  const raw = JSON.stringify({ conversation_id: "c", status: "SUCCESS", response: 'Done.\n{"verdict":"issues","findings":[{"severity":"important","what":"x"}]}', usage: {} });
  expect(parseCriticOutput(raw, "antigravity")).toEqual({ verdict: "issues", findings: [{ severity: "important", what: "x" }] });
});

test("parseCriticOutput: antigravity status !== SUCCESS is fail-open, not a silent verdict from .response", () => {
  const raw = JSON.stringify({ conversation_id: "c", status: "ERROR", response: '{"verdict":"ok","findings":[]}' });
  expect(() => parseCriticOutput(raw, "antigravity")).toThrow(CriticParseError);
});
