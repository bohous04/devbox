// Guard for setInterval: a tick that is still running (slow du, large repo, network) is
// not started a second time — it is skipped. The same pattern index.ts already had by hand for
// accountPollRunning/startUsagePoll; here once and for all.
export function guardedTick(label: string, fn: () => Promise<void>): () => void {
  let running = false;
  return () => {
    if (running) return;
    running = true;
    // `fn` has the type `() => Promise<void>`, but it does not have to be an `async function` —
    // a synchronous throw FROM INSIDE (before it manages to return a promise) would bypass
    // the `.catch()` on the call's result and leave `running` `true` forever. A dedicated
    // try/catch around the CALL (not `Promise.resolve().then(fn)` — that would start fn
    // only in the next microtask and break the assumption of tests and callers that fn
    // starts synchronously) routes both cases onto the same path: log and release
    // `running`.
    let result: Promise<void>;
    try {
      result = fn();
    } catch (e) {
      console.error(`${label} failed:`, e);
      running = false;
      return;
    }
    result
      .catch((e) => console.error(`${label} failed:`, e))
      .finally(() => { running = false; });
  };
}
