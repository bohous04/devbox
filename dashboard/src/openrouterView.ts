// OpenRouter card logic separate from the component — the dashboard has no component tests,
// the pure function is tested (same as vaultView, subscriptionsView and co.).
export interface OpenrouterView { hasKey: boolean; model: string | null }

/** Badge in the top right. The key and the model are TWO independent inputs and each has a different
 *  fix, so they must not merge into one "not set" — the user would then look
 *  in the field where the cause is not. Green belongs only to the state in which the profile will actually
 *  run: with a half-done configuration the session ends up in zsh with a message from agent-launch,
 *  and a green badge above that would claim the exact opposite. */
export function openrouterStatus(v: OpenrouterView | null): { text: string; tone: "ok" | "warn" } {
  if (!v) return { text: "Loading…", tone: "warn" };
  if (!v.hasKey) return { text: "Not connected", tone: "warn" };
  if (!v.model) return { text: "No model set", tone: "warn" };
  return { text: "Active", tone: "ok" };
}

/** Button text next to the key field. Three different operations, three different words — "Save"
 *  over an empty field with a key already set would hide that the key is being DELETED. */
export function saveLabel(hasKey: boolean, input: string): string {
  if (!hasKey) return "Save key";
  return input.trim() ? "Replace key" : "Disconnect";
}
