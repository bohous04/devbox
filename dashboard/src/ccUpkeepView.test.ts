import { expect, test } from "bun:test";
import { busyLabel, fleetBadge, historyLine, isOlder, paneLabel, rowState } from "./ccUpkeepView";
import type { CcSessionStatus, CcStatus } from "./api";

const s = (over: Partial<CcSessionStatus> = {}): CcSessionStatus => ({
  id: "a", project: "apps", repo: "a", version: "2.1.220", panes: 1, stalePanes: 0, busyPct: 4, ...over,
});

const status = (sessions: CcSessionStatus[], latest: string | null = "2.1.220"): CcStatus => ({
  latest, image: "2.1.220", sessions,
});

test("isOlder compares numbers, not strings", () => {
  expect(isOlder("2.1.9", "2.1.10")).toBe(true);
  expect(isOlder("2.1.220", "2.1.207")).toBe(false);
  expect(isOlder("2.1.220", "2.1.220")).toBe(false);
});

test("rowState: old version on disk = outdated", () => {
  expect(rowState(s({ version: "2.1.207" }), "2.1.220")).toBe("outdated");
});

test("rowState: stale pane = outdated even with a current version", () => {
  expect(rowState(s({ version: "2.1.220", stalePanes: 2 }), "2.1.220")).toBe("outdated");
});

test("rowState: current version and panes = current", () => {
  expect(rowState(s(), "2.1.220")).toBe("current");
});

test("rowState: unknown version (unreachable container) = unknown, not outdated", () => {
  expect(rowState(s({ version: null }), "2.1.220")).toBe("unknown");
});

test("rowState: without a known latest the version is not judged, panes are", () => {
  expect(rowState(s({ version: "2.1.207" }), null)).toBe("current");
  expect(rowState(s({ version: "2.1.207", stalePanes: 1 }), null)).toBe("outdated");
});

test("busyLabel tells idle from busy with a 25 % threshold", () => {
  expect(busyLabel(4)).toBe("idle 4 %");
  expect(busyLabel(58)).toBe("busy 58 %");
  expect(busyLabel(null)).toBe("?");
});

test("paneLabel: unknown values are not faked as zero", () => {
  expect(paneLabel(null, null)).toBe("?");
  expect(paneLabel(2, null)).toBe("2 (? stale)");
});

test("rowState: unknown panes = unknown, not current", () => {
  expect(rowState(s({ version: "2.1.220", stalePanes: null }), "2.1.220")).toBe("unknown");
});

test("paneLabel pluralizes stale panes", () => {
  expect(paneLabel(3, 0)).toBe("3");
  expect(paneLabel(3, 1)).toBe("3 (1 stale)");
  expect(paneLabel(3, 2)).toBe("3 (2 stale)");
  expect(paneLabel(7, 5)).toBe("7 (5 stale)");
});

test("fleetBadge: shows nothing healthy without a loaded state", () => {
  expect(fleetBadge(null)).toEqual({ variant: "outline", label: "?" });
});

test("fleetBadge: no running session is not 'all current'", () => {
  expect(fleetBadge(status([]))).toEqual({ variant: "outline", label: "no sessions" });
});

test("fleetBadge: all current = all current", () => {
  expect(fleetBadge(status([s(), s({ id: "b" })]))).toEqual({ variant: "outline", label: "all up to date" });
});

test("fleetBadge: an outdated session = destructive badge", () => {
  expect(fleetBadge(status([s(), s({ id: "b", version: "2.1.1" })]))).toEqual({
    variant: "destructive", label: "1 of 2 outdated",
  });
});

test("fleetBadge: all-unknown sessions are not all current", () => {
  expect(fleetBadge(status([s({ version: null }), s({ id: "b", version: null })]))).toEqual({
    variant: "outline", label: "2 of 2 unknown",
  });
});

test("fleetBadge: outdated and unknown together — destructive does not disappear", () => {
  expect(fleetBadge(status([s({ version: "2.1.1" }), s({ id: "b", version: null })]))).toEqual({
    variant: "destructive", label: "1 of 2 outdated",
  });
});

/* ---------------------- history in plain language ---------------------- */

test("cc_upgraded: install + pane restart", () => {
  const l = historyLine("cc_upgraded", JSON.stringify({ from: "2.1.1", to: "2.1.4", installed: true, restarted: 2, stuck: 0 }));
  expect(l.tone).toBe("ok");
  expect(l.text).toContain("installed 2.1.4");
  expect(l.text).toContain("was 2.1.1");
  expect(l.text).toContain("restarted 2 panes");
});

test("cc_upgraded: restart only, no install (disk was current)", () => {
  const l = historyLine("cc_upgraded", JSON.stringify({ from: "2.1.4", to: "2.1.4", installed: false, restarted: 1, stuck: 0 }));
  expect(l.text).toBe("restarted 1 pane");
  expect(l.text).not.toContain("installed");
});

test("cc_upgraded with a stuck pane warns, does not celebrate", () => {
  const l = historyLine("cc_upgraded", JSON.stringify({ to: "2.1.4", installed: true, restarted: 1, stuck: 1 }));
  expect(l.tone).toBe("warn");
  expect(l.text).toContain("did not come back");
});

test("cc_skipped busy states the REASON and that it will retry", () => {
  const inst = historyLine("cc_skipped", JSON.stringify({ reason: "busy", phase: "install", to: "2.1.4" }));
  expect(inst.text).toContain("the agent was working");
  expect(inst.text).toContain("next run");
  const rest = historyLine("cc_skipped", JSON.stringify({ reason: "busy", phase: "restart", pane: "main.0" }));
  expect(rest.text).toContain("main.0");
});

test("cc_skipped did-not-exit is harmless, not an error", () => {
  const l = historyLine("cc_skipped", JSON.stringify({ reason: "did-not-exit", pane: "main.1" }));
  expect(l.tone).toBe("info");
  expect(l.text).toContain("picks up the new one");
});

test("cc_restart_failed clearly says it will not fix itself", () => {
  const l = historyLine("cc_restart_failed", JSON.stringify({ targets: ["main.0", "main.2"], reason: "did-not-return" }));
  expect(l.tone).toBe("danger");
  expect(l.text).toContain("2 panes");
  expect(l.text).toContain("will not fix itself");
});

// Incident 2026-08-18: the pane had a running agent, it was just stuck on a resume prompt.
// A sentence about a "pane without an agent" would send the person looking elsewhere.
test("cc_restart_failed with a stuck dialog says the agent is running and waiting for an answer", () => {
  const l = historyLine("cc_restart_failed", JSON.stringify({ targets: ["main.0"], reason: "stuck-on-dialog" }));
  expect(l.tone).toBe("danger");
  expect(l.text).toContain("resume prompt");
  expect(l.text).toContain("waiting for an answer");
  expect(l.text).not.toContain("without a running agent");
});

test("cc_upgrade_failed shows the last stderr line, not the whole output", () => {
  const l = historyLine("cc_upgrade_failed", JSON.stringify({ to: "2.1.4", stderr: "npm warn foo\nnpm ERR! EACCES" }));
  expect(l.tone).toBe("danger");
  expect(l.text).toContain("EACCES");
  expect(l.text).not.toContain("npm warn foo");
});

test("historyLine never crashes on broken data", () => {
  expect(historyLine("cc_upgraded", null).text).toBeTruthy();
  expect(historyLine("cc_upgraded", "{ this is not JSON").text).toBeTruthy();
  expect(historyLine("cc_skipped", "[]").text).toBeTruthy();
  expect(historyLine("neznamy_typ", null).text).toBe("neznamy_typ");
});

// Regression 2026-08-21: a blind restart via `cc --continue` handed four
// containers one and the same foreign conversation. When the id cannot be determined, the pane
// stays at the shell instead — and the line must say what to do, not just "failed".
test("cc_restart_failed with an unknown conversation says nothing was restored and how to get it back", () => {
  const l = historyLine("cc_restart_failed", JSON.stringify({ targets: ["main.0"], reason: "unknown-session" }));
  expect(l.tone).toBe("danger");
  expect(l.text).toContain("could not be identified");
  expect(l.text).toContain("claude --resume");
});
