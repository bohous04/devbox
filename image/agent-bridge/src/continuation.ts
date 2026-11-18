// Restart continuation guard (T3 RestartContinuation.ts): at most 3 automatic continuations in 5 minutes,
// so a bridge that crashes on every continuation does not loop forever.
export const CONTINUATION_WINDOW_MS = 5 * 60_000;
export const MAX_CONTINUATIONS = 3;

export const CONTINUATION_TEXT = "Your previous turn was cut short by a restart. Check whether its last action took effect, then continue.";

/** `history`: epoch ms of earlier automatic continuations. */
export function mayContinue(history: number[], now: number): boolean {
  return history.filter((t) => now - t < CONTINUATION_WINDOW_MS).length < MAX_CONTINUATIONS;
}
