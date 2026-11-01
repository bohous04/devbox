import { expect, test } from "bun:test";
import type { SessionInfo } from "../src/api";
import { MANAGER_BACK, MANAGER_BROWSE, MANAGER_NEW, MANAGER_QUIT, browseOptions, detailActions, exitMenuOptions, landingOptions, runningSessions, trimPreview, MANAGER_WHOLE, subSessionOptions, subDetailActions } from "../src/manager-view";
import type { TmuxSession } from "../../devd/src/tmux";

const s = (over: Partial<SessionInfo>): SessionInfo => ({
  id: "dev-shop-web-1", folder: "acme", project: "shop", repo: "web", container: "c",
  port_base: 0, status: "running", solo: 0, created_at: 0, last_active_at: 0, important: 0, ports: [], ...over,
});

const t = (over: Partial<TmuxSession>): TmuxSession => ({ name: "main", label: null, agent: null, title: null, attached: 0, ...over });

test("runningSessions: only running, most recently active first", () => {
  const list = [
    s({ id: "a", last_active_at: 100 }),
    s({ id: "b", last_active_at: 300 }),
    s({ id: "stopped", status: "stopped", last_active_at: 999 }),
  ];
  expect(runningSessions(list).map((x) => x.id)).toEqual(["b", "a"]);
});

test("landingOptions: New session first, Running sessions second (with count), Quit last", () => {
  const opts = landingOptions(3);
  expect(opts.map((o) => o.value)).toEqual([MANAGER_NEW, MANAGER_BROWSE, MANAGER_QUIT]);
  expect(opts[0].label).toContain("New");
  expect(opts[1].label).toContain("Running sessions");
  expect(opts[1].hint).toContain("3");
  expect(opts[2].label).toContain("Quit");
});

test("browseOptions: session rows (recent-active hints) then ← Back, 🔔 on important", () => {
  const now = 10_000_000;
  const running = [
    s({ id: "b", project: "shop", repo: "api", last_active_at: now - 2 * 3600_000, important: 1 }),
    s({ id: "a", project: "infra", repo: "web", last_active_at: now - 5 * 60_000 }),
  ];
  const opts = browseOptions(running, now);
  expect(opts.map((o) => o.value)).toEqual(["b", "a", MANAGER_BACK]);
  expect(opts[0].label).toContain("shop/api");
  expect(opts[0].hint).toContain("2 h");
  expect(opts[0].hint).toContain("🔔");
  expect(opts[1].hint).toContain("5 m");
  expect(opts[1].hint).not.toContain("🔔");
  expect(opts[2].label).toContain("Back");
});

test("browseOptions: no running sessions → only ← Back", () => {
  expect(browseOptions([], 0).map((o) => o.value)).toEqual([MANAGER_BACK]);
});

test("browseOptions: working session shows working, not active-ago", () => {
  const now = 10_000_000;
  // the prompt came 10 min ago, but the agent has been working since (metrics flowing) → "working", not "active 10m ago".
  const running = [s({ id: "w", project: "shop", repo: "web", last_active_at: now - 10 * 60_000, claudeState: "working" })];
  const hint = browseOptions(running, now)[0].hint!;
  expect(hint).toContain("working");
  expect(hint).not.toContain("active");
});

test("browseOptions: waiting/idle keep active-ago; idle has 💤", () => {
  const now = 10_000_000;
  const running = [
    s({ id: "wait", last_active_at: now - 3 * 60_000, claudeState: "waiting" }),
    s({ id: "idle", last_active_at: now - 30 * 60_000, claudeState: "idle" }),
  ];
  const opts = browseOptions(running, now);
  const wait = opts.find((o) => o.value === "wait")!.hint!;
  expect(wait).toContain("active");
  expect(wait).toContain("3 m");
  const idle = opts.find((o) => o.value === "idle")!.hint!;
  expect(idle).toContain("active");
  expect(idle).toContain("💤");
});

test("browseOptions: without claudeState (older devd) falls back to active-ago", () => {
  const now = 10_000_000;
  const running = [s({ id: "x", last_active_at: now - 4 * 60_000 })];
  const hint = browseOptions(running, now)[0].hint!;
  expect(hint).toContain("active");
  expect(hint).toContain("4 m");
});

test("detailActions(true): attach, rename, agent, end, back (default end label)", () => {
  const opts = detailActions(true);
  expect(opts.map((a) => a.value)).toEqual(["attach", "rename", "agent", "end", "back"]);
  expect(opts.find((o) => o.value === "end")!.label).toBe("End session (permanent)");
});

test("detailActions(false, endLabel): no attach + custom end label (whole-session view)", () => {
  const opts = detailActions(false, { endLabel: "End all sessions for games/game_agents" });
  expect(opts.map((a) => a.value)).toEqual(["rename", "agent", "end", "back"]);
  expect(opts.find((o) => o.value === "end")!.label).toBe("End all sessions for games/game_agents");
});

// Switching the agent is container-level (DEVD_AGENT is shared by all windows), so it is in both
// views. The label carries the CURRENT profile — without it the user would be switching blind.
test("detailActions: Change agent shows the current profile", () => {
  const label = detailActions(true, { agentNow: "Claude Code + OpenRouter" }).find((o) => o.value === "agent")!.label;
  expect(label).toContain("Change agent");
  expect(label).toContain("Claude Code + OpenRouter");
  expect(detailActions(true).find((o) => o.value === "agent")!.label).toBe("⇄ Change agent");
});

test("browseOptions: custom name is the label, repo kept in hint", () => {
  const now = 10_000_000;
  const running = [s({ id: "x", project: "shop", repo: "claudeSolo-3", name: "openclaw izolace", last_active_at: now - 60_000 })];
  const opts = browseOptions(running, now);
  expect(opts[0].label).toContain("openclaw izolace");
  expect(opts[0].label).not.toContain("claudeSolo-3");
  expect(opts[0].hint).toContain("shop/claudeSolo-3");
  expect(opts[0].hint).toContain("1 m");
});

test("trimPreview: drops trailing blank lines, clamps to max, empty on blank", () => {
  expect(trimPreview("a\nb\nc\n\n\n")).toEqual(["a", "b", "c"]);
  expect(trimPreview("1\n2\n3\n4", 2)).toEqual(["3", "4"]);
  expect(trimPreview("")).toEqual([]);
  expect(trimPreview("   \n  \n")).toEqual([]);
});

// "Back to session" is the FIRST choice on purpose: F9 can be pressed by mistake and "End session"
// used to be first — an accidental F9 + a reflexive Enter meant an ended session (for a worktree
// also deleted files). Going back must be the safe default.
test("exitMenuOptions: Back / End / Rename / Change agent / Just detach (no Stop)", () => {
  const opts = exitMenuOptions(false);
  expect(opts.map((o) => o.value)).toEqual(["back", "end", "rename", "agent", "detach"]);
  expect(opts[0].label).toContain("Back");
  expect(opts[1].label).toContain("End");
  expect(opts[4].label).toContain("detach");
});

// F9 is the fastest path in the real flow "the OR agent got stuck → switch to claude":
// the user is attached in a tab and has neither the manager nor the dashboard at hand.
test("exitMenuOptions: Change agent shows the current profile", () => {
  const label = exitMenuOptions(false, null, "Claude Code + OpenRouter").find((o) => o.value === "agent")!.label;
  expect(label).toContain("Change agent");
  expect(label).toContain("Claude Code + OpenRouter");
  expect(exitMenuOptions(false).find((o) => o.value === "agent")!.label).toBe("⇄ Change agent");
});

test("F9 offers account switching for native Claude and Codex only, with automatic Claude selection explicit", () => {
  const codex = exitMenuOptions(false, "PHD PDM", "Codex", "codex");
  expect(codex.map(o => o.value)).toEqual(["back", "end", "rename", "agent", "account", "detach"]);
  expect(codex.find(o => o.value === "account")!.label).toContain("Codex");
  expect(exitMenuOptions(false, null, "Claude Code", "claude").find(o => o.value === "account")!.label).toContain("automatic selection");
  for (const agent of ["claude-gpt", "claude-grok", "claude-openrouter", "grok"] as const) {
    expect(exitMenuOptions(false, null, agent, agent).some(o => o.value === "account")).toBe(false);
  }
});

// The label carries the current nickname on purpose: after renaming, the menu is shown again, so
// it is the only feedback that something happened. Without a nickname it must say "unnamed",
// not nothing — empty parentheses look like a bug.
test("exitMenuOptions: Rename shows the current nickname, otherwise unnamed", () => {
  expect(exitMenuOptions(false, "refaktor")[2].label).toContain("refaktor");
  expect(exitMenuOptions(false, null)[2].label).toContain("unnamed");
  expect(exitMenuOptions(false)[2].label).toContain("unnamed");
});

// F9 is the fastest way to end a session, and for a worktree session `end()` is destructive
// (it deletes the working directory including uncommitted changes). The "workspace stays" label
// claimed the exact opposite of what happens.
test("exitMenuOptions: for a worktree session the label does not lie about the files", () => {
  expect(exitMenuOptions(true)[1].label).toContain("deleted");
  expect(exitMenuOptions(false)[1].label).not.toContain("deleted");
});

// One sentence about the outcome of an agent switch — shared by the F9 menu and the manager. It must
// handle every API answer (unchanged / noAgent / success with partial failure / failure).
import { agentSwitchSummary } from "../src/manager-view";

test("agentSwitchSummary: success, partial success, failure, unchanged, no-agent", () => {
  const pane = (target: string, outcome: string) => ({ target, outcome });
  expect(agentSwitchSummary({ status: "unchanged", panes: [] }, "Codex")).toContain("Already");
  expect(agentSwitchSummary({ status: "no-agent", panes: [] }, "Codex")).toContain("No running agent");
  expect(agentSwitchSummary({ status: "switched", panes: [pane("main:0.0", "restarted")] }, "Codex"))
    .toContain("Switched to Codex");
  const partial = agentSwitchSummary(
    { status: "switched", panes: [pane("main:0.0", "restarted"), pane("main-2:0.0", "did-not-exit")] }, "Codex");
  expect(partial).toContain("main-2:0.0");
  expect(partial).toContain("did-not-exit");
  const failed = agentSwitchSummary({ status: "failed", panes: [pane("main:0.0", "did-not-exit")] }, "Codex");
  expect(failed).toContain("failed");
  expect(failed).toContain("did-not-exit");
});

test("subSessionOptions: one row per Claude + Whole session + Back", () => {
  const opts = subSessionOptions([
    t({ name: "main", title: "fixing auth", attached: 1 }),
    t({ name: "main-2", label: "SHOP-58", attached: 0 }),
  ]);
  expect(opts.map((o) => o.value)).toEqual([
    "main", "main-2", MANAGER_WHOLE, MANAGER_BACK,
  ]);
  expect(opts[0].label).toContain("main");
  expect(opts[0].label).toContain("fixing auth"); // title as the label
  expect(opts[0].label).toContain("🔗");          // attached>0
  expect(opts[1].label).toContain("SHOP-58");     // manual label
  expect(opts[1].label).not.toContain("🔗");      // attached=0
  expect(opts.at(-2)!.label).toContain("Whole session");
});

// Sub-sessions (another window over the SAME files) are no longer created: tmux and the agent open
// windows themselves and "another session" now means its own container with its own worktree.
// The list stays as a menu of where to ATTACH — windows from before have not gone anywhere.
test("the manager no longer offers creating a sub-session", () => {
  const opts = subSessionOptions([t({ name: "main" })]);
  expect(opts.map((o) => o.value)).toEqual(["main", MANAGER_WHOLE, MANAGER_BACK]);
});

test("subDetailActions: attach/rename/kill/back in order", () => {
  expect(subDetailActions().map((a) => a.value)).toEqual(["attach", "rename", "kill", "back"]);
});

test("subSessionOptions: agent label shown when known, silent when null (mix Codex main + Claude main-2)", () => {
  const opts = subSessionOptions([
    t({ name: "main", agent: "codex" }),
    t({ name: "main-2", label: "SHOP-58", agent: "claude" }),
    t({ name: "main-3", agent: null }),
  ]);
  expect(opts[0].label).toBe("main · Codex");
  expect(opts[1].label).toBe("main-2 · Claude Code · SHOP-58");
  expect(opts[2].label).toBe("main-3"); // agent unknown (old image) → name only, as before
});
