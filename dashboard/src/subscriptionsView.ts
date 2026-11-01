import { ApiError, type CodexSubscriptionView, type GrokSubscriptionView } from "./api";

/** Window length for the label under the gauge. Codex sends minutes, not names — 300 is "5h",
 *  10080 "7d". Anything that does not come out to whole hours or days stays in minutes, so the label
 *  does not lie by rounding. */
export function codexWindowLabel(windowMinutes: number | null): string {
  if (windowMinutes === null || windowMinutes <= 0) return "—";
  if (windowMinutes % 1440 === 0) return `${windowMinutes / 1440}d`;
  if (windowMinutes % 60 === 0) return `${windowMinutes / 60}h`;
  return `${windowMinutes}m`;
}

/** Badge in the top right of the card. An exhausted limit beats the `ok` state: "Active" above
 *  a hundred-percent gauge would be the worst possible message.
 *
 *  The "error" tone is `warn`, not `danger` — the same "Usage unavailable" message has
 *  a grey badge on the Anthropic cards next to it (accountsView.ts); red next to grey for
 *  the same word reads as a difference that does not exist.
 *
 *  The last line is an explicit `state === "ok"`, not a bare fallback: an unknown state
 *  (an older dashboard against a newer devd, or an added state that was
 *  forgotten) thus gets its own badge instead of a false "Active". */
/** Shared state→badge map for all usage cards (Codex and Grok) — the rule
 *  "an unknown state MUST NOT fall through to a false Active" is enforced in one place.
 *  `limitReached` is sent only by Codex; other sources leave the default null. */
export function stateBadge(
  state: CodexSubscriptionView["state"], limitReached: string | null = null,
): { text: string; tone: "ok" | "warn" | "danger" } {
  if (state === "signed-out") return { text: "Not signed in", tone: "warn" };
  if (state === "stale-login") return { text: "Stale login", tone: "warn" };
  if (state === "error") return { text: "Usage unavailable", tone: "warn" };
  if (limitReached !== null) return { text: "Limit reached", tone: "danger" };
  if (state === "ok") return { text: "Active", tone: "ok" };
  return { text: "Unknown status", tone: "warn" };
}

export const codexStatus = (c: CodexSubscriptionView) => stateBadge(c.state, c.limitReached);

// Codes the API returns that can be translated into a sentence. The literal code stays
// visible in the message — without it the problem can be neither traced nor reported.
const CODE_HINTS: { match: string; text: string }[] = [
  { match: "deactivated_workspace", text: "the ChatGPT workspace behind this login is deactivated" },
  { match: "unknown-shape", text: "the API answered in an unexpected shape — devd needs updating" },
];

/** Sentence under the badge, or `null` when there is nothing to say. The order mirrors `codexStatus`
 *  (signed-out/stale-login/error beat limitReached — `writeFail` in codexPoller.ts
 *  keeps the old `limit_reached` even across a new error, so both can be set
 *  at once) — so the badge and the sentence under it always concern the same thing.
 *
 *  I5: previously `null` was returned for anything that was not `state === "error"` — i.e. also
 *  for a healthy poll with an exhausted limit. The "Limit reached" badge thus stayed without
 *  an explanation, the only dead end in the whole design. The branch now hangs on
 *  `limitReached !== null`, not on the state. */
/** Error sentence shared by all usage cards. #9: `raw` often already CARRIES its own
 *  parentheses (e.g. "deactivated_workspace (HTTP 402)"), so `hint.text (${raw})`
 *  used to produce doubled parentheses — a colon instead of more parentheses, the literal code
 *  stays visible without duplication. */
export function usageErrorText(error: string | null): string {
  const raw = error ?? "unknown error";
  const hint = CODE_HINTS.find((h) => raw.includes(h.match));
  return hint ? `${hint.text}: ${raw}` : `Couldn't read usage: ${raw}`;
}

export function codexIssue(c: CodexSubscriptionView): string | null {
  if (c.state === "signed-out") return "Not signed in — run `codex login` in the devbox.";
  if (c.state === "stale-login") return "The stored token expired — run `codex login` in the devbox.";
  if (c.state === "error") return usageErrorText(c.error);
  if (c.limitReached !== null) return `Codex plan limit reached: ${c.limitReached}. It resets automatically — no action needed.`;
  return null;
}

/** #10: `GET /api/subscriptions/codex` fails in two ways indistinguishable at
 *  first glance — 404, because THIS devd (an older build) does not have the endpoint at all,
 *  and anything else (network, 5xx…), which is a real failure. `.catch(() => setCodex(null))`
 *  used to lump them into the same `null` as "there is no Codex on this devbox" and the card
 *  silently disappeared — unlike AnthropicAccounts next to it, which shows the error.
 *
 *  404 must keep hiding the card (a dashboard newer than its devd is a legitimate state),
 *  everything else must stay visible as an error. */
export function codexFetchFailure(e: unknown): { hidden: true } | { hidden: false; message: string } {
  if (e instanceof ApiError && e.status === 404) return { hidden: true };
  return { hidden: false, message: e instanceof Error ? e.message : String(e) };
}

/** State of a usage card (Codex and Grok) AFTER one poll. Invariant: the poll result
 *  fully determines what the card shows, nothing may be inherited from before — except `view`
 *  in the error branch, where the last known numbers are kept on purpose (same
 *  convention as `writeFail` in devd/src/codexPoller.ts). 404 (an older devd without the
 *  route) hides the card, a real error stays visible.
 *
 *  The regression reason this is extracted into a pure function, not inline in the component:
 *  `hidden` (set by a 404 response, see `codexFetchFailure`) used to be cleared ONLY
 *  in the success branch. The sequence "404, then a real error, no success in between" left
 *  `hidden` set and `if (hidden) return null;` in the component silenced the real
 *  error too — exactly what #10 was supposed to remove. */
export interface SubCardState<T> { view: T | null | undefined; hidden: boolean; fetchErr: string | null }
export type SubPollOutcome<T> = { ok: true; view: T | null } | { ok: false; error: unknown };

export function subCardState<T>(prev: SubCardState<T>, outcome: SubPollOutcome<T>): SubCardState<T> {
  if (outcome.ok) return { view: outcome.view, hidden: false, fetchErr: null };
  const f = codexFetchFailure(outcome.error);
  if (f.hidden) return { view: prev.view, hidden: true, fetchErr: null };
  return { view: prev.view, hidden: false, fetchErr: f.message };
}

export const SUB_CARD_LOADING: SubCardState<never> = { view: undefined, hidden: false, fetchErr: null };

export type CodexCardState = SubCardState<CodexSubscriptionView>;
export const CODEX_CARD_LOADING: CodexCardState = SUB_CARD_LOADING;
export const codexCardState = subCardState<CodexSubscriptionView>;

export type GrokCardState = SubCardState<GrokSubscriptionView>;
export const GROK_CARD_LOADING: GrokCardState = SUB_CARD_LOADING;
export const grokCardState = subCardState<GrokSubscriptionView>;

export const grokStatus = (g: GrokSubscriptionView) => stateBadge(g.state);

/** Grok is logged in from the dashboard (Settings → Log in with Grok), not by a command
 *  in the devbox — the hint points to where it can be clicked. */
export function grokIssue(g: GrokSubscriptionView): string | null {
  if (g.state === "signed-out") return "Not signed in — use Log in with Grok in Settings below.";
  if (g.state === "stale-login") return "The stored token expired — log in with Grok again in Settings below.";
  if (g.state === "error") return usageErrorText(g.error);
  return null;
}
