import { expect, test } from "bun:test";
import {
  CODEX_CARD_LOADING, codexCardState, codexFetchFailure, codexIssue, codexStatus, codexWindowLabel,
  GROK_CARD_LOADING, grokCardState, grokIssue, grokStatus,
} from "./subscriptionsView";
import { ApiError, type CodexSubscriptionView, type GrokSubscriptionView } from "./api";

const cx = (over: Partial<CodexSubscriptionView> = {}): CodexSubscriptionView => ({
  state: "ok", planType: "plus",
  windows: [{ kind: "primary", usedPct: 42, windowMinutes: 300, resetsAt: null }],
  credits: null, limitReached: null, fetchedAt: 1_787_224_361_140, error: null, ...over,
});

test("codexWindowLabel: minutes to a human label", () => {
  expect(codexWindowLabel(300)).toBe("5h");
  expect(codexWindowLabel(10_080)).toBe("7d");
  expect(codexWindowLabel(60)).toBe("1h");
  expect(codexWindowLabel(90)).toBe("90m");
  expect(codexWindowLabel(null)).toBe("—");
});

test("codexStatus: the state decides the badge", () => {
  expect(codexStatus(cx())).toEqual({ text: "Active", tone: "ok" });
  expect(codexStatus(cx({ state: "signed-out" }))).toEqual({ text: "Not signed in", tone: "warn" });
  expect(codexStatus(cx({ state: "stale-login" }))).toEqual({ text: "Stale login", tone: "warn" });
  // Same tone as "Usage unavailable" on the Anthropic cards (accountsView.ts) —
  // previously "danger", which next to a grey badge for the same word read as a difference
  // that does not exist.
  expect(codexStatus(cx({ state: "error" }))).toEqual({ text: "Usage unavailable", tone: "warn" });
  expect(codexStatus(cx({ limitReached: "workspace_member_usage_limit_reached" })))
    .toEqual({ text: "Limit reached", tone: "danger" });
});

// An unknown state (older dashboard against a newer devd) MUST NOT fall through to a silent
// "Active" fallback — the failure direction would be false reassurance.
test("codexStatus: an unknown state gets its own badge, not a silent Active", () => {
  const unknown = cx({ state: "future-state" as unknown as CodexSubscriptionView["state"] });
  expect(codexStatus(unknown)).toEqual({ text: "Unknown status", tone: "warn" });
});

// The API code is translated into a sentence, but the literal code stays visible — without it
// it cannot be traced, and this is exactly the real state of a live login today.
test("codexIssue: a known code gets a sentence, an unknown one is shown verbatim", () => {
  expect(codexIssue(cx())).toBe(null);
  expect(codexIssue(cx({ state: "error", error: "deactivated_workspace (HTTP 402)" })))
    .toContain("deactivated");
  expect(codexIssue(cx({ state: "error", error: "unknown-shape" }))).toContain("shape");
  expect(codexIssue(cx({ state: "error", error: "something else entirely" }))).toContain("something else entirely");
  expect(codexIssue(cx({ state: "signed-out" }))).toContain("codex login");
  expect(codexIssue(cx({ state: "stale-login" }))).toContain("codex login");
});

// #9: the raw code often carries parentheses itself ("… (HTTP 402)") — the message must not double them.
test("codexIssue: a raw code with parentheses is not doubled", () => {
  const issue = codexIssue(cx({ state: "error", error: "deactivated_workspace (HTTP 402)" }))!;
  expect(issue).not.toContain("((");
  expect(issue).toContain("deactivated_workspace (HTTP 402)");
});

// I5: the "Limit reached" badge (see codexStatus above) must not stay without an accompanying
// sentence — previously `null` was returned for anything other than `state === "error"`.
test("codexIssue: an exhausted limit has its own explanatory sentence", () => {
  const issue = codexIssue(cx({ limitReached: "workspace_member_usage_limit_reached" }));
  expect(issue).toContain("workspace_member_usage_limit_reached");
  expect(issue).not.toBe(null);
});

// #10: a 404 (older devd without the endpoint) is hidden like `codex: null`;
// anything else is a real failure and MUST stay visible, not disappear silently.
test("codexFetchFailure: a 404 is hidden, another error stays visible with a message", () => {
  expect(codexFetchFailure(new ApiError("not found", 404))).toEqual({ hidden: true });
  expect(codexFetchFailure(new ApiError("internal error", 500)))
    .toEqual({ hidden: false, message: "internal error" });
  expect(codexFetchFailure(new TypeError("Failed to fetch")))
    .toEqual({ hidden: false, message: "Failed to fetch" });
  expect(codexFetchFailure("weird non-error throw")).toEqual({ hidden: false, message: "weird non-error throw" });
});

// Regression in the fix wave: `hidden` from a 404 used to be cleared ONLY in the success branch, so
// the sequence "404, then a real error, no success in between" left the card silent —
// exactly what #10 was meant to remove. codexCardState is the only place that decides
// this, so it is tested here, not through an invented render harness (none exists for
// this page in the repo — see the other tests next to it, which also test
// only the extracted view logic, not components).
test("codexCardState: 404 then a real error with no success in between → the error is visible", () => {
  const afterNotFound = codexCardState(CODEX_CARD_LOADING, { ok: false, error: new ApiError("not found", 404) });
  expect(afterNotFound).toEqual({ view: undefined, hidden: true, fetchErr: null });

  const afterRealError = codexCardState(afterNotFound, { ok: false, error: new ApiError("internal error", 500) });
  expect(afterRealError.hidden).toBe(false);
  expect(afterRealError.fetchErr).toBe("internal error");
});

test("codexCardState: success always fully determines the state, even codex: null clears an old error/hidden", () => {
  const afterError = codexCardState(CODEX_CARD_LOADING, { ok: false, error: new Error("boom") });
  expect(afterError.fetchErr).toBe("boom");

  const afterSuccessNull = codexCardState(afterError, { ok: true, view: null });
  expect(afterSuccessNull).toEqual({ view: null, hidden: false, fetchErr: null });
});

// The error branch keeps the last known numbers (same convention as writeFail in
// devd/src/codexPoller.ts) — only hidden/fetchErr are reset, not codex.
test("codexCardState: an error after success keeps the last numbers", () => {
  const known = cx({ planType: "plus" });
  const afterSuccess = codexCardState(CODEX_CARD_LOADING, { ok: true, view: known });
  const afterError = codexCardState(afterSuccess, { ok: false, error: new Error("network down") });
  expect(afterError).toEqual({ view: known, hidden: false, fetchErr: "network down" });
});

const gr = (over: Partial<GrokSubscriptionView> = {}): GrokSubscriptionView => ({
  state: "ok", tier: "SuperGrok", usedPct: null, resetsAt: 1_787_800_838_000,
  fetchedAt: 1_787_224_361_140, error: null, ...over,
});

// Same rules as codexStatus, just without limitReached (Grok sends nothing like that).
test("grokStatus: the state decides the badge, an unknown state does not fall through to Active", () => {
  expect(grokStatus(gr())).toEqual({ text: "Active", tone: "ok" });
  expect(grokStatus(gr({ state: "signed-out" }))).toEqual({ text: "Not signed in", tone: "warn" });
  expect(grokStatus(gr({ state: "stale-login" }))).toEqual({ text: "Stale login", tone: "warn" });
  expect(grokStatus(gr({ state: "error" }))).toEqual({ text: "Usage unavailable", tone: "warn" });
  const unknown = gr({ state: "future" as unknown as GrokSubscriptionView["state"] });
  expect(grokStatus(unknown)).toEqual({ text: "Unknown status", tone: "warn" });
});

// Grok signs in from the dashboard (Settings → Log in with Grok), not with a command
// in the devbox — the hint must point where it can actually be clicked.
test("grokIssue: signed-out/stale lead to Settings, an error shows the literal code", () => {
  expect(grokIssue(gr())).toBe(null);
  expect(grokIssue(gr({ state: "signed-out" }))).toContain("Settings");
  expect(grokIssue(gr({ state: "stale-login" }))).toContain("Settings");
  expect(grokIssue(gr({ state: "error", error: "HTTP 401 denied" }))).toContain("HTTP 401 denied");
  expect(grokIssue(gr({ state: "error", error: "unknown-shape" }))).toContain("shape");
});

// grokCardState shares its mechanics with codexCardState (one generic function) — this
// pins the grok side of that contract: a 404 hides, a real error stays visible and keeps
// the last known numbers.
test("grokCardState: a 404 hides, an error after success keeps the numbers and is visible", () => {
  const afterNotFound = grokCardState(GROK_CARD_LOADING, { ok: false, error: new ApiError("not found", 404) });
  expect(afterNotFound).toEqual({ view: undefined, hidden: true, fetchErr: null });

  const known = gr();
  const afterSuccess = grokCardState(afterNotFound, { ok: true, view: known });
  expect(afterSuccess).toEqual({ view: known, hidden: false, fetchErr: null });

  const afterError = grokCardState(afterSuccess, { ok: false, error: new Error("network down") });
  expect(afterError).toEqual({ view: known, hidden: false, fetchErr: "network down" });
});
