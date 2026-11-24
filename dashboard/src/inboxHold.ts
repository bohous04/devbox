import type { InboxItem } from "../../shared/thread";
import { asks } from "./inboxView";

/** While the mouse is over the inbox, a live update keeps the rows in the order shown, so a click or the ✓ does not land
 *  on a row that slid under the pointer. Rows that come are placed without moving the others: a new ask on top (it is
 *  the one thing that must not wait unseen), anything else at the end. A row that leaves still takes its line with it,
 *  so the rows below move up by one. The hold is mouse-only: a touch screen has no pointer resting over a row. */
export type HoldKey = "list" | "working" | "snoozed";
export type Lists = Record<HoldKey, InboxItem[]>;
/** Each list's order (session ids) since the hold began, including rows that left meanwhile, so a row brought back
 *  (an undo) returns to its old line. */
export type Hold = Record<HoldKey, readonly string[]>;

const ids = (rows: InboxItem[]) => rows.map((i) => i.sessionId);

/** `items` laid out on `order`; the same `order` back when no row is new to it. */
export function holdOrder(order: readonly string[], items: InboxItem[]): { rows: InboxItem[]; order: readonly string[] } {
  const known = new Set(order);
  const fresh = items.filter((i) => !known.has(i.sessionId));
  if (fresh.length === 0) {
    const by = new Map(items.map((i) => [i.sessionId, i]));
    return { rows: order.flatMap((id) => by.get(id) ?? []), order };
  }
  const next = [...ids(fresh.filter(asks)), ...order, ...ids(fresh.filter((i) => !asks(i)))];
  return holdOrder(next, items);
}

/** The lists as shown under `hold`, and the hold to keep (the same object while nothing new came). */
export function applyHold(hold: Hold | null, lists: Lists): { lists: Lists; hold: Hold | null } {
  if (!hold) return { lists, hold };
  const list = holdOrder(hold.list, lists.list), working = holdOrder(hold.working, lists.working), snoozed = holdOrder(hold.snoozed, lists.snoozed);
  const same = list.order === hold.list && working.order === hold.working && snoozed.order === hold.snoozed;
  return {
    lists: { list: list.rows, working: working.rows, snoozed: snoozed.rows },
    hold: same ? hold : { list: list.order, working: working.order, snoozed: snoozed.order },
  };
}

/** What the page sees: the mouse entering or moving over the column (with the lists as shown right then), leaving it,
 *  or the window losing focus or being hidden. A mouse resting while he reads keeps the hold (a timer letting go would
 *  re-sort the rows under it); a new ask still comes on top. */
export type HoldEvent =
  | { type: "enter" | "move"; pointerType: string; shown: Lists }
  | { type: "leave" | "blur" | "hidden" };

export function onHoldEvent(hold: Hold | null, e: HoldEvent): Hold | null {
  if (e.type === "enter" || e.type === "move") {
    if (e.pointerType !== "mouse") return hold;
    return hold ?? { list: ids(e.shown.list), working: ids(e.shown.working), snoozed: ids(e.shown.snoozed) };
  }
  return null;
}
