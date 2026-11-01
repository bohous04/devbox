import { expect, test } from "bun:test";
import {
  agentLaunchCmd, PROFILE_ENV, switchAgent, switchShellPrefix, tmuxEnvScript,
  type SwitchAgentDeps,
} from "../src/agentSwitch";
import type { ExecResult } from "../src/ccUpkeep";
import { getSession, getRepoAgent, insertSession, listEvents, openDb, type SessionRow } from "../src/db";
import { PROXY_ENV_KEYS } from "../src/sessions";

const NOW = 1_800_000_000_000;

const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "", timedOut: false });

const ROW: SessionRow = {
  id: "dev-shop-cms", folder: "acme", project: "shop", repo: "cms", container: "dev-shop-cms",
  port_base: 40100, status: "running", solo: 0, created_at: 0, last_active_at: 0, important: 0,
  agent: "claude-openrouter",
};

// ── pure builders ────────────────────────────────────────────────────────────────

test("switchShellPrefix: clears ALL profile variables and exports the new profile", () => {
  const p = switchShellPrefix("claude", {});
  // The old proxy profile left ANTHROPIC_* exported in the pane's shell — without unset
  // "claude" would keep talking to OpenRouter.
  for (const v of PROFILE_ENV) expect(p).toContain(v);
  for (const v of PROXY_ENV_KEYS) expect(p).toContain(v);
  expect(p).toContain("export DEVD_AGENT='claude'");
  // Reset to the image default; NEVER remove entirely (without the variable cc goes to ~/.claude.json).
  expect(p).toContain("CLAUDE_CONFIG_DIR='/home/dev/.claude'");
});

test("switchShellPrefix: a proxy target gets fresh DEVD_* values and does not unset them", () => {
  const proxy = { DEVD_AGENT_MODEL: "stealth/ox-alpha", DEVD_UPSTREAM_URL: "https://openrouter.ai/api", DEVD_UPSTREAM_KEY: "or-key" };
  const p = switchShellPrefix("claude-openrouter", proxy);
  expect(p).toContain("DEVD_AGENT_MODEL='stealth/ox-alpha'");
  expect(p).toContain("DEVD_UPSTREAM_KEY='or-key'");
  // The key must not end up in the unset list (unset runs before export, but a confusing duplicate
  // would silently kill the key if the command were reordered).
  expect(p.split("export")[0]).not.toContain("DEVD_AGENT_MODEL");
  // DEVD_AGENT_CTX is not in the proxy env → clear it (the old profile may have had a 1M window).
  expect(p.split("export")[0]).toContain("DEVD_AGENT_CTX");
});

test("agentLaunchCmd: profile + optional --resume", () => {
  expect(agentLaunchCmd("codex", null)).toBe("/usr/local/bin/agent-launch codex");
  expect(agentLaunchCmd("claude", "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"))
    .toBe("/usr/local/bin/agent-launch claude --resume aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
});

test("tmuxEnvScript: sets DEVD_AGENT + proxy values, unsets missing DEVD_*", () => {
  const s = tmuxEnvScript("claude-grok", { DEVD_AGENT_MODEL: "grok-4.6", DEVD_UPSTREAM_URL: "http://h:8317", DEVD_UPSTREAM_KEY: "k1", DEVD_CLIPROXY_URL: "http://h:8317", DEVD_CLIPROXY_KEY: "k1" });
  expect(s).toContain("set-environment -g DEVD_AGENT 'claude-grok'");
  expect(s).toContain("set-environment -g DEVD_AGENT_MODEL 'grok-4.6'");
  // DEVD_AGENT_CTX missing → unset, so a new window does not inherit a foreign context window.
  expect(s).toContain("set-environment -gu DEVD_AGENT_CTX");
  expect(s).not.toContain("set-environment -gu DEVD_AGENT_MODEL");
});

test("tmuxEnvScript: a native target unsets all DEVD_* proxy names", () => {
  const s = tmuxEnvScript("claude", {});
  for (const v of PROXY_ENV_KEYS) expect(s).toContain(`set-environment -gu ${v}`);
});

// ── orchestrace ────────────────────────────────────────────────────────────────

function deps(over: Partial<SwitchAgentDeps> = {}): SwitchAgentDeps {
  const db = openDb(":memory:");
  insertSession(db, ROW);
  return {
    db,
    exec: async () => ok(),
    sleep: async () => {},
    now: () => NOW,
    inFlight: new Set<string>(),
    proxyEnvFor: async () => ({}),
    ...over,
  };
}

test("unknown session → unknown-session, no exec", async () => {
  let calls = 0;
  const d = deps({ exec: async () => { calls++; return ok(); } });
  expect(await switchAgent(d, "dev-missing", "claude")).toEqual({ status: "unknown-session" });
  expect(calls).toBe(0);
});

test("stopped session → not-running", async () => {
  const db = openDb(":memory:");
  insertSession(db, { ...ROW, status: "stopped" });
  expect(await switchAgent(deps({ db }), ROW.id, "claude")).toEqual({ status: "not-running" });
});

test("target == current profile → unchanged, no exec", async () => {
  let calls = 0;
  const d = deps({ exec: async () => { calls++; return ok(); } });
  expect(await switchAgent(d, ROW.id, "claude-openrouter")).toEqual({ status: "unchanged" });
  expect(calls).toBe(0);
});

test("concurrent switch on the same session → in-progress", async () => {
  const d = deps({ inFlight: new Set([ROW.id]) });
  expect(await switchAgent(d, ROW.id, "claude")).toEqual({ status: "in-progress" });
});

test("no pane with a live agent → no-agent, DB unchanged", async () => {
  const d = deps({
    exec: async (_c, cmd) => {
      if (cmd[0] === "tmux" && cmd[1] === "list-panes") return ok("main:0.0\t62\n");
      if (cmd[0] === "ps") return ok("   62    1 900 zsh\n");
      return ok();
    },
  });
  expect(await switchAgent(d, ROW.id, "claude")).toEqual({ status: "no-agent" });
  expect(getSession(d.db, ROW.id)!.agent).toBe("claude-openrouter");
});

/** Stateful container fake: pane 62 with a running agent `fromComm`; after send-keys
 *  `/exit` (or `kill`) the agent disappears, after send-keys with agent-launch
 *  `toComm` appears. Records the sent commands for asserts. */
function fakeContainer(opts: {
  fromComm: string; toComm: string;
  banner?: string;              // screen text after cc exits (exit banner)
  freshTranscript?: boolean;    // find transcript returns a match
  cmdline?: string;             // /proc/<pid>/cmdline of the live agent
}) {
  const sent: string[] = [];
  let phase: "running" | "gone" | "relaunched" = "running";
  const exec = async (_c: string, cmd: string[]): Promise<ExecResult> => {
    if (cmd[0] === "tmux" && cmd[1] === "list-panes") return ok("main:0.0\t62\n");
    if (cmd[0] === "ps") {
      if (phase === "running") return ok(`   62    1 900 zsh\n   64   62 300 ${opts.fromComm}\n`);
      if (phase === "gone") return ok("   62    1 900 zsh\n");
      return ok(`   62    1 900 zsh\n   70   62 5 ${opts.toComm}\n`);
    }
    if (cmd[0] === "cat" && cmd[1] === "/proc/64/cmdline") return ok(opts.cmdline ?? "claude");
    if (cmd[0] === "cat" && cmd[1] === "/proc/64/environ") return ok("CLAUDE_CONFIG_DIR=/home/dev/.claude\0");
    if (cmd[0] === "kill") { phase = "gone"; return ok(); }
    if (cmd[0] === "tmux" && cmd[1] === "send-keys") {
      const keys = cmd.slice(3).join(" ");
      sent.push(keys);
      if (keys.includes("/exit")) phase = "gone";
      if (keys.includes("agent-launch")) phase = "relaunched";
      return ok();
    }
    if (cmd[0] === "tmux" && cmd[1] === "capture-pane") {
      if (phase === "gone" && opts.banner) return ok(opts.banner);
      return ok("");   // after relaunch: no resume dialog
    }
    if (cmd[0] === "find") return ok(opts.freshTranscript ? "/x/aaaaaaaa.jsonl\n" : "");
    return ok();
  };
  return { exec, sent };
}

const OR_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

test("claude→claude profile: /exit, id from the banner, agent-launch with --resume, DB + repo pref + audit", async () => {
  const c = fakeContainer({
    fromComm: "claude", toComm: "claude",
    banner: `Resume this session with:\nclaude --resume ${OR_ID}`,
    freshTranscript: true,
  });
  const d = deps({ exec: c.exec });
  const r = await switchAgent(d, ROW.id, "claude");
  expect(r).toEqual({ status: "switched", panes: [{ target: "main:0.0", outcome: "restarted" }] });
  const launch = c.sent.find((s) => s.includes("agent-launch"))!;
  expect(launch).toContain(`/usr/local/bin/agent-launch claude --resume ${OR_ID}`);
  // the prefix is part of the SAME line (export into the pane's shell, see accountSwitch)
  expect(launch).toContain("export DEVD_AGENT='claude'");
  expect(getSession(d.db, ROW.id)!.agent).toBe("claude");
  expect(getRepoAgent(d.db, ROW.folder, ROW.project, ROW.repo)).toBe("claude");
  const ev = listEvents(d.db, { session: ROW.id }).find((e) => e.type === "agent-switch-live");
  expect(ev).toBeDefined();
});

test("claude→claude without a verifiable id: starts CLEAN (no --resume), not unknown-session", async () => {
  // The banner is on screen, but the transcript is not fresh → the id must not be guessed.
  // Unlike ccUpkeep (which leaves the pane at the shell), a clean start is right here:
  // the user explicitly asked for the profile switch.
  const c = fakeContainer({
    fromComm: "claude", toComm: "claude",
    banner: `Resume this session with:\nclaude --resume ${OR_ID}`,
    freshTranscript: false,
  });
  const d = deps({ exec: c.exec });
  const r = await switchAgent(d, ROW.id, "claude");
  expect(r.status).toBe("switched");
  const launch = c.sent.find((s) => s.includes("agent-launch"))!;
  expect(launch).not.toContain("--resume");
});

test("claude→codex: graceful /exit, launch without --resume", async () => {
  const c = fakeContainer({ fromComm: "claude", toComm: "codex" });
  const d = deps({ exec: c.exec });
  const r = await switchAgent(d, ROW.id, "codex");
  expect(r.status).toBe("switched");
  expect(c.sent.some((s) => s.includes("/exit"))).toBe(true);
  const launch = c.sent.find((s) => s.includes("agent-launch"))!;
  expect(launch).toContain("/usr/local/bin/agent-launch codex");
  expect(launch).not.toContain("--resume");
});

test("codex→claude: the agent is stopped with kill, not /exit (codex does not know the slash command)", async () => {
  const db = openDb(":memory:");
  insertSession(db, { ...ROW, agent: "codex" });
  const c = fakeContainer({ fromComm: "codex", toComm: "claude" });
  const d = deps({ db, exec: c.exec });
  const r = await switchAgent(d, ROW.id, "claude");
  expect(r.status).toBe("switched");
  expect(c.sent.some((s) => s.includes("/exit"))).toBe(false);
});

test("agent refuses to exit → did-not-exit → failed, DB stays on the old profile", async () => {
  const exec = async (_c: string, cmd: string[]): Promise<ExecResult> => {
    if (cmd[0] === "tmux" && cmd[1] === "list-panes") return ok("main:0.0\t62\n");
    if (cmd[0] === "ps") return ok("   62    1 900 zsh\n   64   62 300 claude\n");   // claude never disappears
    if (cmd[0] === "cat") return ok("claude");
    return ok();
  };
  const d = deps({ exec });
  const r = await switchAgent(d, ROW.id, "claude");
  expect(r).toEqual({ status: "failed", panes: [{ target: "main:0.0", outcome: "did-not-exit" }] });
  expect(getSession(d.db, ROW.id)!.agent).toBe("claude-openrouter");
});

test("tmux env switches for future windows too (set-environment -g)", async () => {
  const scripts: string[] = [];
  const c = fakeContainer({ fromComm: "claude", toComm: "codex" });
  const exec = async (cn: string, cmd: string[]): Promise<ExecResult> => {
    if (cmd[0] === "sh" && cmd[1] === "-c") { scripts.push(cmd[2]!); return ok(); }
    return c.exec(cn, cmd);
  };
  await switchAgent(deps({ exec }), ROW.id, "codex");
  expect(scripts.some((s) => s.includes("set-environment -g DEVD_AGENT 'codex'"))).toBe(true);
});
