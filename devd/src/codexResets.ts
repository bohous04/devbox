import { isCodexResetStatus, type CodexResetSnapshot } from "../../shared/codexResets";

// One cache per server, independent from the five-second live session polling.
export function createCodexResetReader(request: typeof fetch = fetch, now = Date.now) {
  let snapshot: CodexResetSnapshot = { status: null, fetchedAt: null, stale: true };
  let nextAttempt = 0;
  let pending: Promise<CodexResetSnapshot> | null = null;
  return function read(): Promise<CodexResetSnapshot> {
    if (pending) return pending;
    if (now() < nextAttempt) return Promise.resolve(snapshot);
    pending = (async () => {
      nextAttempt = now() + 5 * 60_000;
      try {
        const response = await request("https://codex-resets.com/api/v1/status", { signal: AbortSignal.timeout(8000), headers: { accept: "application/json" } });
        if (!response.ok) {
          if (response.status === 429) {
            const delay = Number(response.headers.get("retry-after"));
            if (Number.isFinite(delay) && delay > 0) nextAttempt = now() + Math.max(delay * 1000, 5 * 60_000);
          }
          throw new Error(`Reset service returned ${response.status}`);
        }
        const status: unknown = await response.json();
        if (!isCodexResetStatus(status)) throw new Error("Invalid reset response");
        snapshot = { status, fetchedAt: now(), stale: false };
      } catch { snapshot = { ...snapshot, stale: true }; }
      return snapshot;
    })().finally(() => { pending = null; });
    return pending;
  };
}
