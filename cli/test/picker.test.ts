import { expect, test } from "bun:test";
import { AGENT_IDS } from "../../devd/src/agents";
import type { SessionRow } from "../../devd/src/db";
import type { TreeProject } from "../../devd/src/tree";
import { agentFlag, agentOptions, folderOptions, freshLabel, gistOutcome, NEW_SOLO, projectOptions, repoOptions, runningSolosIn, shouldAskAgent, soloActionOptions, soloEndOptions, soloMenuOptions, stripAgentFlags } from "../src/picker";

const session = (over: Partial<SessionRow>): SessionRow => ({
  id: "id", folder: "acme", project: "shop", repo: "claudeSolo-1", container: "c",
  port_base: 0, status: "running", solo: 1, created_at: 0, last_active_at: 0, important: 0, ...over,
});

const tree: TreeProject[] = [
  { folder: "acme", project: "shop", repos: [
    { name: "web", cloneUrl: "u", provider: "github", cloned: false },
    { name: "cms", cloneUrl: "u", provider: "github", cloned: true },
  ]},
  { folder: "apps", project: "apps", repos: [] },
];

test("folder and project options", () => {
  expect(folderOptions(tree).map((o) => o.value)).toEqual(["acme", "apps"]);
  expect(projectOptions(tree, "acme").map((o) => o.value)).toEqual(["shop"]);
});

test("repo options: recents first, cloned hint, claudeSolo appended", () => {
  const opts = repoOptions(tree, [{ folder: "acme", project: "shop", repo: "web", cloned: false }], "acme", "shop");
  expect(opts.map((o) => o.value)).toEqual(["web", "cms", "claudeSolo"]);
  expect(opts.find((o) => o.value === "cms")?.hint).toBe("cloned");
});

test("solo end options default to delete", () => {
  expect(soloEndOptions()[0]).toMatchObject({ value: "delete" });
  expect(soloEndOptions().map((o) => o.value)).toEqual(["delete", "keep", "gist"]);
});

test("gist outcome deletes only when gist creation succeeded", () => {
  expect(gistOutcome(0)).toBe("delete");
  expect(gistOutcome(1)).toBe("keep");
});

test("solo action options: running offers attach and gist, stopped omits both", () => {
  expect(soloActionOptions("running").map((o) => o.value)).toEqual(["attach", "delete", "keep", "gist"]);
  expect(soloActionOptions("stopped").map((o) => o.value)).toEqual(["delete", "keep"]);
});

test("runningSolosIn: only running solo of that folder/project, most recently active first", () => {
  const sessions = [
    session({ id: "a", repo: "claudeSolo-1", last_active_at: 100 }),
    session({ id: "b", repo: "claudeSolo-2", last_active_at: 300 }),
    session({ id: "stopped", status: "stopped" }),
    session({ id: "notsolo", solo: 0 }),
    session({ id: "otherproject", project: "other" }),
    session({ id: "otherfolder", folder: "apps" }),
  ];
  expect(runningSolosIn(sessions, "acme", "shop").map((s) => s.id)).toEqual(["b", "a"]);
});

test("runningSolosIn: no running solo → empty (caller takes the fast path)", () => {
  expect(runningSolosIn([session({ status: "stopped" })], "acme", "shop")).toEqual([]);
});

test("soloMenuOptions: new-session button first, then running with active-ago hint + important marker", () => {
  const now = 10_000_000;
  const running = [
    session({ id: "b", repo: "claudeSolo-2", last_active_at: now - 2 * 3600_000, important: 1 }),
    session({ id: "a", repo: "claudeSolo-1", last_active_at: now - 5 * 60_000 }),
  ];
  const opts = soloMenuOptions(running, now);
  expect(opts.map((o) => o.value)).toEqual([NEW_SOLO, "b", "a"]);
  expect(opts[0].label).toContain("New");
  expect(opts[1].label).toContain("claudeSolo-2");
  expect(opts[1].hint).toContain("2 h");
  expect(opts[1].hint).toContain("🔔");
  expect(opts[2].hint).toContain("5 m");
  expect(opts[2].hint).not.toContain("🔔");
});

test("soloMenuOptions: a working solo shows working, not active-ago", () => {
  const now = 10_000_000;
  const running = [{ ...session({ id: "w", repo: "claudeSolo-9", last_active_at: now - 10 * 60_000 }), claudeState: "working" as const }];
  const hint = soloMenuOptions(running, now)[1].hint!;
  expect(hint).toContain("working");
  expect(hint).not.toContain("active");
});

test("agentFlag: --codex / --claude, jinak undefined", () => {
  expect(agentFlag(["shop/app", "--codex"])).toBe("codex");
  expect(agentFlag(["--claude", "shop/app"])).toBe("claude");
  expect(agentFlag(["shop/app"])).toBeUndefined();
  expect(agentFlag([])).toBeUndefined();
});

test("agentFlag: both flags at once → --codex wins (intentional, pinned)", () => {
  expect(agentFlag(["shop/app", "--codex", "--claude"])).toBe("codex");
  expect(agentFlag(["--claude", "--codex", "shop/app"])).toBe("codex");
});

test("agentOptions: the remembered agent comes first, also for a profile other than codex", () => {
  expect(agentOptions("claude")[0].value).toBe("claude");
  expect(agentOptions("grok")[0].value).toBe("grok");
});

// Switching the agent on a running session uses the same menu, just with a "current" hint —
// in that context "last used here" lies (first is the session's CURRENT profile, not the repo's memory).
test("agentOptions: custom hint for the agent-switch context", () => {
  const opts = agentOptions("claude-openrouter", "current");
  expect(opts[0].value).toBe("claude-openrouter");
  expect(opts[0].hint).toBe("current");
});

test("--agent <id> picks a profile; the old shortcuts still work", () => {
  expect(agentFlag(["--agent", "claude-grok", "shop/app"])).toBe("claude-grok");
  expect(agentFlag(["--codex"])).toBe("codex");
  expect(agentFlag(["--claude"])).toBe("claude");
  expect(agentFlag(["shop/app"])).toBeUndefined();
});

test("--agent with nonsense picks nothing (the caller then reports an error)", () => {
  expect(agentFlag(["--agent", "gpt"])).toBeUndefined();
  expect(agentFlag(["--agent"])).toBeUndefined();
});

test("stripAgentFlags also removes the VALUE of --agent so it does not stay as a target", () => {
  expect(stripAgentFlags(["--agent", "grok", "shop/app"])).toEqual(["shop/app"]);
  expect(stripAgentFlags(["--codex", "shop/app"])).toEqual(["shop/app"]);
  expect(stripAgentFlags(["stop", "--all"])).toEqual(["stop", "--all"]);  // leaves other flags alone
});

test("the profile menu offers all of them and the remembered one is first with a hint", () => {
  const opts = agentOptions("codex");
  // The length comes from AGENT_IDS, not a number: this tests BUILDING the menu, not how
  // many profiles exist right now — that list is guarded by devd/test/agents.test.ts.
  expect(opts).toHaveLength(AGENT_IDS.length);
  expect(opts[0].value).toBe("codex");
  expect(opts[0].hint).toBe("last used here");
  expect(opts.map((o) => o.value).sort()).toEqual([...AGENT_IDS].sort());
  expect(opts[0].label).toBe("Codex (co · yolo)");
});

test("shouldAskAgent: only the step picker with a TTY and no forced agent asks", () => {
  expect(shouldAskAgent(undefined, undefined, true)).toBe(true);   // dev → picker
  expect(shouldAskAgent("shop/app", undefined, true)).toBe(false); // dev shop/app
  expect(shouldAskAgent(undefined, "codex", true)).toBe(false);    // dev --codex
  expect(shouldAskAgent(undefined, undefined, false)).toBe(false); // notification click, automation
});

// I3 from the review: "New session (own worktree and branch)" promised a repo in the old layout
// (shared working directory) something it does not get — its own container yes, its own files
// and branch no. And since ALL repos on the VPS are old today, that was the default case.
test("freshLabel: promises its own worktree only where the session really gets one", () => {
  expect(freshLabel({ bare: true, cloned: true })).toContain("own worktree");
  // An uncloned repo is cloned straight into the new layout → it gets its own worktree too.
  expect(freshLabel({ bare: false, cloned: false })).toContain("own worktree");
  // Old layout: the workspace exists, the bare clone does not → shared files and branch.
  expect(freshLabel({ bare: false, cloned: true })).not.toContain("own worktree");
  expect(freshLabel({ bare: false, cloned: true })).toContain("shares");
  // Older devd does not send `bare` — that must not turn into a promise.
  expect(freshLabel({ cloned: true })).not.toContain("own worktree");
});
