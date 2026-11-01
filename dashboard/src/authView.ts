export function providerBadge(p: { loggedIn: boolean }): { text: string; tone: "ok" | "warn" } {
  return p.loggedIn ? { text: "Logged in", tone: "ok" } : { text: "Not logged in", tone: "warn" };
}

/** Older devd does not have the `antigravity` field in `/api/auth` yet — if the row were shown
 *  with the NOT_LOGGED_IN fallback, the "Sign in with Google" button would end in a 404.
 *  Until the status arrives (`null`) it is hidden, same as when it arrives without the field. */
export function showAgyRow(status: { antigravity?: unknown } | null): boolean {
  return status?.antigravity !== undefined;
}

/** Submission state of the authorization code in `CodeLoginRow` (Antigravity) — extracted as a pure
 *  reducer so it can be tested without rendering the component. "submitting" blocks a double submit
 *  (a quick double click/Enter would otherwise send the same code to the stateful tmux pane twice);
 *  "sent" keeps the form locked after success until the dialog closes or a new
 *  sign-in starts. The error is shown directly in the dialog (not only in the banner outside the modal, which is
 *  hidden behind the overlay) and is cleared on the next submit/begin/close. */
export type CodeSubmitPhase = "idle" | "submitting" | "sent";
export interface CodeSubmitState { phase: CodeSubmitPhase; error: string | null }
export const CODE_SUBMIT_IDLE: CodeSubmitState = { phase: "idle", error: null };

export function canSubmitCode(state: CodeSubmitState, code: string): boolean {
  return code.trim().length > 0 && state.phase === "idle";
}
export function codeSubmitStart(): CodeSubmitState {
  return { phase: "submitting", error: null };
}
export function codeSubmitSucceeded(): CodeSubmitState {
  return { phase: "sent", error: null };
}
export function codeSubmitFailed(message: string): CodeSubmitState {
  return { phase: "idle", error: message };
}
