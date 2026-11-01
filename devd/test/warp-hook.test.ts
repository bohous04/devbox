import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "..", "..", "image", "vendor", "warp-hooks", "warp-hook.sh");
const hasJq = Bun.spawnSync(["bash", "-lc", "command -v jq"]).exitCode === 0;

function runHook(event: string, stdin = "{}"): { code: number; stdout: string } {
  const p = Bun.spawnSync(["bash", script, event], {
    stdin: new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: p.exitCode ?? 1, stdout: p.stdout.toString() };
}

test.skipIf(!hasJq)("warp-hook on `stop` emits a done status (badge in Warp's agent list)", () => {
  const r = runHook("stop", '{"session_id":"s1","cwd":"/workspace/proj"}');
  expect(r.code).toBe(0);
  expect(r.stdout).toContain("terminalSequence");
  expect(r.stdout).toContain("warp://cli-agent");
  expect(r.stdout).toContain('\\"event\\":\\"stop\\"'); // done state → Warp draws a "done" badge
});

test.skipIf(!hasJq)("warp-hook on `tool_complete` emits a cli-agent status", () => {
  const r = runHook("tool_complete", '{"session_id":"s1","cwd":"/workspace/proj"}');
  expect(r.code).toBe(0);
  expect(r.stdout).toContain("terminalSequence");
  expect(r.stdout).toContain("warp://cli-agent");
});

// --tty mode: Codex/Grok cannot do (have not measured) Claude Code's terminalSequence contract,
// so the hook must write OSC 777 to the pane's tty ITSELF — in a hand-wrapped tmux passthrough
// envelope (ESC P tmux; … ESC \, inner ESC doubled). A fake `tmux` in PATH returns a path
// to a plain file instead of the pane tty; the test then reads what the hook wrote into it.
function runTty(event: string, opts: { pane?: string; stdin?: string; agent?: string; nativeGrok?: boolean; claude?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "warptty-"));
  const tty = join(dir, "pane-tty");
  writeFileSync(tty, "");
  const fakeTmux = join(dir, "tmux");
  // Title-format lookups get the devbox session title; everything else the pane tty.
  writeFileSync(fakeTmux, `#!/usr/bin/env bash\ncase "\${*: -1}" in *@devd_session_name*) echo "PHD Banka" ;; *) printf '%s\\n' "$FAKE_PANE_TTY" ;; esac\n`);
  chmodSync(fakeTmux, 0o755);
  // The Linux image has coreutils timeout; stock macOS does not. Keep the same
  // bounded subprocess behavior when running this fixture on a developer Mac.
  const timeout = join(dir, "timeout");
  writeFileSync(timeout, `#!/usr/bin/env python3\nimport subprocess,sys\ntry:\n sys.exit(subprocess.run(sys.argv[2:],timeout=float(sys.argv[1].removesuffix('s'))).returncode)\nexcept subprocess.TimeoutExpired:\n sys.exit(124)\n`);
  chmodSync(timeout, 0o755);
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PATH: `${dir}:${process.env.PATH}`,
    FAKE_PANE_TTY: tty,
    CODEX_HOME: join(dir, "codex"),
    GROK_HOME: join(dir, "grok"),
    DEVD_WARP_AGENT: opts.agent ?? "claude",
    DEVD_WARP_GROK_NATIVE: opts.nativeGrok ? "1" : "0",
  };
  if ("pane" in opts && !opts.pane) delete env.TMUX_PANE;
  else env.TMUX_PANE = opts.pane ?? "%5";
  const p = Bun.spawnSync(["bash", script, ...(opts.claude ? [] : ["--tty"]), event], {
    stdin: new TextEncoder().encode(opts.stdin ?? '{"session_id":"s1","cwd":"/workspace/proj"}'),
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  return { code: p.exitCode ?? 1, stdout: p.stdout.toString(), ttyOut: readFileSync(tty, "utf8") };
}

test.skipIf(!hasJq)("--tty writes a passthrough-wrapped OSC 777 to the pane tty, leaves stdout empty", () => {
  const r = runTty("stop");
  expect(r.code).toBe(0);
  // stdout MUST stay empty: the Codex/Grok Stop hook reads stdout as a verdict
  // ({"decision":"block"} critic contract) — terminalSequence JSON would get in the way there.
  expect(r.stdout.trim()).toBe("");
  expect(r.ttyOut.startsWith("\x1bPtmux;")).toBe(true);
  expect(r.ttyOut.endsWith("\x1b\\")).toBe(true);
  expect(r.ttyOut).toContain("\x1b\x1b]777;");   // inner ESC doubled (passthrough rule)
  expect(r.ttyOut).toContain("warp://cli-agent");
  // Explicit Claude transport retains its identity.
  expect(r.ttyOut).toContain('"agent":"claude"');
  expect(r.ttyOut).toContain('"event":"stop"');
});

test.skipIf(!hasJq)("--tty passes the event into the payload", () => {
  const r = runTty("permission_request");
  expect(r.code).toBe(0);
  expect(r.ttyOut).toContain('"agent":"claude"');
  expect(r.ttyOut).toContain('"event":"permission_request"');
});

test.skipIf(!hasJq)("--tty keeps Grok's camelCase sessionId in the Warp event", () => {
  const r = runTty("stop", { stdin: '{"sessionId":"grok-123","cwd":"/workspace"}' });
  expect(r.code).toBe(0);
  expect(r.stdout).toBe("");
  expect(r.ttyOut).toContain('"session_id":"grok-123"');
});

test.skipIf(!hasJq)("--tty without TMUX_PANE is a silent no-op (a hook outside tmux must not break anything)", () => {
  const r = runTty("stop", { pane: undefined });
  expect(r.code).toBe(0);
  expect(r.stdout.trim()).toBe("");
  expect(r.ttyOut).toBe("");
});

test.skipIf(!hasJq)("Codex status uses its native identity and direct tmux transport without Warp env", () => {
  for (const event of ["session_start", "prompt_submit", "permission_request", "tool_complete", "stop"]) {
    const r = runTty(event, { agent: "codex" });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.ttyOut).toContain('"agent":"codex"');
    expect(r.ttyOut).toContain(`"event":"${event}"`);
  }
});

test.skipIf(!hasJq)("Codex questions wait for input; noninteractive tools and children stay silent", () => {
  const question = runTty("pre_tool_use", { agent: "codex", stdin: '{"session_id":"root","tool_name":"functions.request_user_input"}' });
  expect(question.ttyOut).toContain('"event":"permission_request"');
  // Summary mirrors the devbox title (Warp tab name), never the question.
  expect(question.ttyOut).toContain('"summary":"PHD Banka"');
  for (const [event, input] of [
    ["pre_tool_use", { session_id: "root", tool_name: "exec_command" }],
    ["prompt_submit", { session_id: "child", agent_id: "child" }],
    ["stop", { sessionId: "child", subagentType: "explore" }],
  ] as const) {
    expect(runTty(event, { agent: "codex", stdin: JSON.stringify(input) }).ttyOut).toBe("");
  }
});


test.skipIf(!hasJq)("Grok legacy environment override works when the client has not negotiated support", () => {
  for (const nativeGrok of [false, true]) {
    const r = runTty("stop_failure", { agent: "grok", nativeGrok, stdin: '{"sessionId":"grok-123","cwd":"/workspace"}' });
    expect(r.stdout).toBe("");
    expect(r.ttyOut).toContain(`"agent":"${nativeGrok ? "grok" : "claude"}"`);
    expect(r.ttyOut).toContain('"event":"stop_failure"');
  }
});

test.skipIf(!hasJq)("Grok-imported Claude hooks stay silent while actual Claude retains terminalSequence", () => {
  for (const event of ["session_start", "prompt_submit", "tool_complete", "stop"]) {
    const imported = runTty(event, { claude: true, stdin: '{"sessionId":"grok-123"}' });
    expect(imported.stdout).toBe("");
    expect(imported.ttyOut).toBe("");
  }
  const actual = runTty("session_start", { claude: true });
  const sequence = JSON.parse(actual.stdout).terminalSequence;
  expect(sequence.startsWith("\x1b]777;notify;warp://cli-agent;")).toBe(true);
  expect(sequence).toContain('"agent":"claude"');
  expect(actual.ttyOut).toBe("");
});

test.skipIf(!hasJq)("Antigravity (agy) carries the Claude badge in Warp and its own conversationId", () => {
  for (const event of ["session_start", "prompt_submit", "tool_complete", "stop"]) {
    const r = runTty(event, { agent: "agy", nativeGrok: true, stdin: '{"session_id":"agy-1","conversationId":"agy-1","cwd":"/workspace"}' });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.ttyOut).toContain('"agent":"claude"');
    expect(r.ttyOut).toContain('"session_id":"agy-1"');
    expect(r.ttyOut).toContain(`"event":"${event}"`);
  }
});
