import { expect, test } from "bun:test";
import {
  CODE_SUBMIT_IDLE, canSubmitCode, codeSubmitFailed, codeSubmitStart, codeSubmitSucceeded, providerBadge, showAgyRow,
} from "./authView";

test("providerBadge: logged in → ok/Logged in, otherwise warn/Not logged in", () => {
  expect(providerBadge({ loggedIn: true })).toEqual({ text: "Logged in", tone: "ok" });
  expect(providerBadge({ loggedIn: false })).toEqual({ text: "Not logged in", tone: "warn" });
});

test("canSubmitCode: blank/whitespace code never submittable, even idle", () => {
  expect(canSubmitCode(CODE_SUBMIT_IDLE, "")).toBe(false);
  expect(canSubmitCode(CODE_SUBMIT_IDLE, "   ")).toBe(false);
  expect(canSubmitCode(CODE_SUBMIT_IDLE, "abc")).toBe(true);
});

test("canSubmitCode: blocked while submitting or after sent (double-submit guard)", () => {
  const submitting = codeSubmitStart();
  expect(canSubmitCode(submitting, "abc")).toBe(false);
  const sent = codeSubmitSucceeded();
  expect(canSubmitCode(sent, "abc")).toBe(false);
});

test("codeSubmitStart: clears any previous error", () => {
  expect(codeSubmitStart()).toEqual({ phase: "submitting", error: null });
});

test("codeSubmitSucceeded: locks the form (phase 'sent'), no error", () => {
  expect(codeSubmitSucceeded()).toEqual({ phase: "sent", error: null });
});

test("codeSubmitFailed: returns to 'idle' (retry allowed) and carries the message for the dialog", () => {
  expect(codeSubmitFailed("invalid authorization code")).toEqual({ phase: "idle", error: "invalid authorization code" });
  expect(canSubmitCode(codeSubmitFailed("x"), "abc")).toBe(true);
});

// Older devd does not have the `antigravity` field in /api/auth yet — without this check the
// row would show NOT_LOGGED_IN and the "Sign in with Google" button would end in a 404.
test("showAgyRow: hidden while status not loaded yet, or loaded without `antigravity`", () => {
  expect(showAgyRow(null)).toBe(false);
  expect(showAgyRow({ antigravity: undefined } as never)).toBe(false);
});

test("showAgyRow: shown once status carries `antigravity` (even logged out)", () => {
  expect(showAgyRow({ antigravity: { loggedIn: false, detail: "…" } } as never)).toBe(true);
  expect(showAgyRow({ antigravity: { loggedIn: true, detail: "x" } } as never)).toBe(true);
});
