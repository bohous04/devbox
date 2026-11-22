import { useEffect, useSyncExternalStore } from "react";
import { api } from "./api";
import { SeenWatch, Settler } from "./inboxSettle";

/** One for the app, as the inbox is: a seen failure on leaving a terminal still shows once the inbox is back. */
export const settler = new Settler({ settle: api.settle, unsettle: api.unsettle, seen: api.tmuxSeen });

export const useSettleState = () => useSyncExternalStore(settler.subscribe, () => settler.state);

const watch = new SeenWatch({
  items: () => api.inbox().then((r) => r.items),
  settler,
  visible: () => document.visibilityState === "visible",
  now: () => Date.now(),
  defer: (fn) => { const t = setTimeout(fn, 0); return () => clearTimeout(t); },
});

/** Marks an open tmux session's finish or failure seen (SeenWatch): on opening it, on coming back to the window while
 *  it is open, and on leaving it. */
export function useTmuxSeen(id: string, enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const onFocus = () => { void watch.focus(id); };
    void watch.open(id);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
      watch.leave(id);
    };
  }, [id, enabled]);
}
