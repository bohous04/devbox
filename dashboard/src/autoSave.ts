/** Serialize writes, keeping the newest pending edit when a request is in flight. */
export function createAutoSave<T>(write: (value: T) => Promise<void>, onError: (error: unknown) => void) {
  let pending: { value: T } | null = null;
  let running: Promise<void> | null = null;
  let failure: unknown = null;
  function start() {
    if (running || !pending) return;
    failure = null;
    running = (async () => {
      while (pending) {
        const current = pending;
        pending = null;
        try { await write(current.value); }
        catch (error) {
          pending ??= current;
          failure = error;
          onError(error);
          break;
        }
      }
    })().finally(() => { running = null; });
  }
  return {
    enqueue(value: T) { pending = { value }; start(); },
    retry: start,
    async flush() { if (running) await running; if (failure) throw failure; },
  };
}
