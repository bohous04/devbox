import { expect, test } from "bun:test";
import type { SessionInfo } from "../src/api";
import { endEffect, endPrompt, formatDoctor, formatOpenProgress, formatPorts, formatSessions, sessionLabel, uptime } from "../src/format";

const row: SessionInfo = {
  id: "dev-shop-cms", folder: "acme", project: "shop", repo: "cms", container: "dev-shop-cms",
  port_base: 40100, status: "running", solo: 0, created_at: 0, last_active_at: 0, important: 0,
  ports: [{ host: 40100, container: 3000 }, { host: 40101, container: 3001 }],
};

test("uptime buckets", () => {
  expect(uptime(12_000)).toBe("12 s");
  expect(uptime(3 * 60_000)).toBe("3 m");
  expect(uptime(2 * 3600_000 + 5 * 60_000)).toBe("2 h 5 m");
});

test("sessions table and empty state", () => {
  expect(formatSessions([], 0)).toBe("No sessions.");
  const out = formatSessions([row], 3600_000);
  expect(out).toContain("● shop/cms");
  expect(out).toContain("1 h 0 m");
  expect(out).toContain("40100");
});

test("sessionLabel: custom name wins, else project/repo, blank name falls back", () => {
  expect(sessionLabel({ name: null, project: "shop", repo: "cms" })).toBe("shop/cms");
  expect(sessionLabel({ name: "Radar", project: "shop", repo: "cms" })).toBe("Radar");
  expect(sessionLabel({ name: "  ", project: "shop", repo: "cms" })).toBe("shop/cms");
});

test("sessions table shows the nickname alongside project/repo", () => {
  const named = { ...row, name: "Radar" };
  const out = formatSessions([named], 3600_000);
  expect(out).toContain("shop/cms");
  expect(out).toContain("Radar");
});

test("ports listing uses host", () => {
  const out = formatPorts(row, "vps");
  expect(out).toContain("3000 → http://vps:40100");
  expect(out).toContain("3001 → http://vps:40101");
});

test("doctor report renders ok and hints", () => {
  const out = formatDoctor([{ name: "devd", ok: true }, { name: "ssh", ok: false, hint: "check tailscale" }]);
  expect(out).toContain("✅ devd");
  expect(out).toContain("❌ ssh");
  expect(out).toContain("check tailscale");
});

test("formatSessions: sub-rows for 2+ sessions and for a single one with a label", () => {
  const two: SessionInfo = { ...row, tmux: [
    { name: "main", label: null, agent: null, title: "✳ Run live verification first", attached: 0 },
    { name: "main-2", label: "SHOP-58", agent: null, title: null, attached: 0 },
  ] };
  const out = formatSessions([two], 0);
  expect(out).toContain("└ main   · Run live verification first");  // name padded to the longest
  expect(out).toContain("└ main-2 · SHOP-58");

  const single: SessionInfo = { ...row, tmux: [
    { name: "main", label: null, agent: null, title: "✳ Plane API integration", attached: 0 },
  ] };
  expect(formatSessions([single], 0)).toContain("└ main · Plane API integration");
});

test("formatSessions: a single main without a label = no sub-rows (today's output)", () => {
  const noisy: SessionInfo = { ...row, tmux: [
    { name: "main", label: null, agent: null, title: "✳ Claude Code", attached: 0 },
  ] };
  expect(formatSessions([noisy], 0)).not.toContain("└");
  expect(formatSessions([row], 0)).not.toContain("└");   // older devd without the tmux field
});

test("formatSessions: sub-rows carry the agent label (mix Codex main + Claude main-2)", () => {
  const mixed: SessionInfo = { ...row, tmux: [
    { name: "main", label: null, agent: "codex", title: null, attached: 0 },
    { name: "main-2", label: "SHOP-58", agent: "claude", title: null, attached: 0 },
  ] };
  const out = formatSessions([mixed], 0);
  expect(out).toContain("└ main   · Codex");
  expect(out).toContain("└ main-2 · Claude Code · SHOP-58");
});

// C1 from the review: `end()` on a worktree session deletes the WHOLE directory (git worktree
// remove --force) — tracked changes, untracked files and .env.local. Only commits on the branch
// survive. Yet the texts claimed "workspace stays/kept", the exact opposite, even in the F9 menu.
test("endEffect: a worktree session admits deleting files, a shared workspace does not", () => {
  expect(endEffect(true)).toContain("deleted");
  expect(endEffect(true)).toContain("branch");
  expect(endEffect(false)).toContain("workspace");
  expect(endEffect(false)).not.toContain("deleted");
});

// Same family as I2: a destructive confirmation must say WHICH session it is about.
// "End ALL sessions for shop/cms?" promised more than `api.end(s.id)` does — it ends
// one container, not all sessions of the repo. While the repo had one session it was the
// same thing; with a second one it is not.
test("endPrompt: names the session, not the repo, and \"all\" means the windows in it", () => {
  const whole = endPrompt("dev-shop-cms-2", { whole: true, worktree: true });
  expect(whole).toContain("dev-shop-cms-2");
  expect(whole).toContain("agent windows");
  expect(whole).toContain("deleted");        // also carries the fate of the files (endEffect)
  expect(whole).not.toContain("ALL sessions for");
  const one = endPrompt("dev-shop-cms", { whole: false, worktree: false });
  expect(one).toContain("dev-shop-cms");
  expect(one).not.toContain("agent windows");
  expect(one).toContain("workspace");
});

test("formatOpenProgress describes the open() step for the spinner", () => {
  expect(formatOpenProgress({ step: "clone" })).toBe("cloning");
  expect(formatOpenProgress({ step: "clone", clone: { phase: "Receiving objects", percent: 45, detail: "3.21 GiB | 30.12 MiB/s" } }))
    .toBe("cloning · Receiving objects 45% · 3.21 GiB | 30.12 MiB/s");
  expect(formatOpenProgress({ step: "worktree" })).toBe("checking out");
  expect(formatOpenProgress({ step: "container" })).toBe("starting container");
});
