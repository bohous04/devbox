import { useEffect, useSyncExternalStore } from "react";
import { api } from "./api";
import { seenMoves, Settler, wantsSeen } from "./inboxSettle";

/** One for the app, as the inbox is: a seen failure on leaving a terminal still shows once the inbox is back. */
export const settler = new Settler({ settle: api.settle, unsettle: api.unsettle, seen: api.tmuxSeen });

export const useSettleState = () => useSyncExternalStore(settler.subscribe, () => settler.state);

/** Marks an open tmux session's finish or failure seen: on opening it, on coming back to the window while it is
 *  open, and on leaving it, each only while the page is visible. A failure is marked on leaving only (seenMoves):
 *  marking it while open would drop its row from the pinned top of the inbox. */
export function useTmuxSeen(id: string, enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const look = (open: boolean) => {
      if (document.visibilityState !== "visible") return;
      api.inbox().then(
        ({ items }) => {
          const item = items.find((i) => i.sessionId === id);
          if (!wantsSeen(item) || (open && seenMoves(item))) return;
          void settler.seen(item);
        },
        (e: Error) => settler.report(`Couldn't mark this session seen: could not read the inbox (${e.message || "request failed"})`),
      );
    };
    const onFocus = () => look(true);
    const onVisible = () => { if (document.visibilityState === "visible") look(true); };
    look(true);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
      look(false);
    };
  }, [id, enabled]);
}
