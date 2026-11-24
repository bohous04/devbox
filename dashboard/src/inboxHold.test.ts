import { expect, test } from "bun:test";
import type { Attention, InboxItem } from "../../shared/thread";
import { applyHold, holdOrder, onHoldEvent, type Hold, type HoldEvent, type Lists } from "./inboxHold";
import { groupInbox, inboxList } from "./inboxView";

const item = (sessionId: string, attention: Attention): InboxItem => ({
  sessionId, runtime: "chat", title: sessionId, project: "p", repo: "r", agent: "claude", attention, lastText: null,
});
const done = (id: string, since: number) => item(id, { section: "needs_you", reason: "completed", since });
const ask = (id: string, since: number) => item(id, { section: "needs_you", reason: "request", since });
const ids = (rows: InboxItem[]) => rows.map((i) => i.sessionId);
// The page's own path: devd's items, grouped and sorted, then held.
const lists = (items: InboxItem[]): Lists => {
  const g = groupInbox(items);
  return { list: inboxList(g), working: g.working, snoozed: g.snoozed };
};
/** Renders like the page does: the lists under the hold, and the hold the layout effect keeps. */
function page() {
  let hold: Hold | null = null;
  let items: InboxItem[] = [];
  const render = () => {
    const out = applyHold(hold, lists(items));
    hold = out.hold;
    return ids(out.lists.list);
  };
  return {
    update(next: InboxItem[]) { items = next; return render(); },
    event(e: Omit<HoldEvent, "shown"> & { pointerType?: string }) {
      const shown = applyHold(hold, lists(items)).lists;
      hold = onHoldEvent(hold, { ...e, shown } as HoldEvent);
      return render();
    },
    get held() { return hold !== null; },
  };
}

test("holdOrder: rows keep their order; a row that left goes; a new ask comes first, anything else last", () => {
  const next = [ask("q", 9), done("d", 8), done("c", 7), done("a", 1)];
  const out = holdOrder(["a", "b", "c"], next);
  expect(ids(out.rows)).toEqual(["q", "a", "c", "d"]);
  // "b" left but keeps its line, so it returns there.
  expect(out.order).toEqual(["q", "a", "b", "c", "d"]);
  const order = ["a", "c"];
  expect(holdOrder(order, [done("c", 8), done("a", 1)]).order).toBe(order);
});

test("the page holds under the mouse, re-sorts on leave, blur, hiding and idle, and never holds for touch", () => {
  const p = page();
  expect(p.update([done("a", 3), done("b", 2), done("c", 1)])).toEqual(["a", "b", "c"]);
  p.event({ type: "enter", pointerType: "touch" });
  expect(p.held).toBe(false);
  p.event({ type: "enter", pointerType: "mouse" });
  expect(p.held).toBe(true);
  // "c" finishes again (now the newest) and an ask arrives: the rows stay, the ask goes on top.
  expect(p.update([done("c", 9), ask("q", 8), done("a", 3), done("b", 2)])).toEqual(["q", "a", "b", "c"]);
  // "b" is settled, then brought back by undo: it returns to its line.
  expect(p.update([done("c", 9), ask("q", 8), done("a", 3)])).toEqual(["q", "a", "c"]);
  expect(p.update([done("c", 9), ask("q", 8), done("a", 3), done("b", 2)])).toEqual(["q", "a", "b", "c"]);
  // A move while held keeps the hold as it is.
  expect(p.event({ type: "move", pointerType: "mouse" })).toEqual(["q", "a", "b", "c"]);
  expect(p.event({ type: "leave" })).toEqual(["q", "c", "a", "b"]);
  for (const type of ["blur", "hidden", "idle"] as const) {
    p.event({ type: "move", pointerType: "mouse" });
    expect(p.held).toBe(true);
    p.event({ type });
    expect(p.held).toBe(false);
  }
});
