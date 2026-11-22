import { expect, spyOn, test } from "bun:test";
import {
  autoOpen, MAX_REMEMBERED_TABS, openTab, pruneTabs, rememberedTab, rememberTab, tabKey, type TabStorage, UNSETTLED, userChoose,
} from "./tmuxTab";

function storage(initial: Record<string, string> = {}): TabStorage & { data: Record<string, string>; writes: number } {
  const st = {
    data: { ...initial } as Record<string, string>, writes: 0,
    getItem: (k: string) => st.data[k] ?? null,
    setItem: (k: string, v: string) => { st.writes++; st.data[k] = v; },
  };
  return st;
}

test("a tmux session's tab is remembered per session; switching back is remembered too", () => {
  const s = storage();
  expect(rememberedTab(s, "a@1")).toBeNull();
  rememberTab(s, "a@1", "chat");
  rememberTab(s, "b@1", "terminal");
  expect(rememberedTab(s, "a@1")).toBe("chat");
  expect(rememberedTab(s, "b@1")).toBe("terminal");
  rememberTab(s, "a@1", "terminal");
  expect(rememberedTab(s, "a@1")).toBe("terminal");
});

test("a session reopened under the same id does not inherit the old one's tab", () => {
  const s = storage();
  rememberTab(s, tabKey("dev-a", 1000), "chat");
  expect(rememberedTab(s, tabKey("dev-a", 1000))).toBe("chat");
  expect(rememberedTab(s, tabKey("dev-a", 2000))).toBeNull();
  // The list then holds only the new one: the old entry goes.
  pruneTabs(s, new Set([tabKey("dev-a", 2000)]));
  expect(rememberedTab(s, tabKey("dev-a", 1000))).toBeNull();
});

test("the tab it opens on: the remembered one, else Chat; a remembered Chat it cannot read opens Terminal", () => {
  expect(openTab(null, true)).toBe("chat");
  expect(openTab("chat", true)).toBe("chat");
  expect(openTab("terminal", true)).toBe("terminal");
  expect(openTab("chat", false)).toBe("terminal");
  expect(openTab(null, false)).toBe("chat");
});

test("only the user's switch is stored; the automatic opening, Terminal for an unreadable agent included, is not", () => {
  const s = storage();
  rememberTab(s, "a@1", "chat");
  const before = s.writes;
  const opened = autoOpen(UNSETTLED, s, "a@1", false);
  expect(opened).toEqual({ tab: "terminal", settled: true });
  expect(s.writes).toBe(before);
  expect(rememberedTab(s, "a@1")).toBe("chat");

  expect(userChoose(s, "a@1", "terminal")).toEqual({ tab: "terminal", settled: true });
  expect(rememberedTab(s, "a@1")).toBe("terminal");
  // Not a tmux session (no key): the switch shows, nothing is stored.
  const writes = s.writes;
  expect(userChoose(s, null, "chat").tab).toBe("chat");
  expect(s.writes).toBe(writes);
});

test("a tab the user picked before the mirror loaded is not overridden by the remembered one", () => {
  const s = storage();
  rememberTab(s, "a@1", "chat");
  const picked = userChoose(s, null, "terminal");
  expect(autoOpen(picked, s, "a@1", true).tab).toBe("terminal");
  expect(autoOpen(UNSETTLED, s, "a@1", true).tab).toBe("chat");
});

test("sessions that no longer exist are pruned; the list is capped, the least recently chosen going first", () => {
  const s = storage();
  rememberTab(s, "a", "chat");
  rememberTab(s, "b", "chat");
  rememberTab(s, "c", "terminal");
  pruneTabs(s, new Set(["a", "c", "z"]));
  expect([rememberedTab(s, "a"), rememberedTab(s, "b"), rememberedTab(s, "c")]).toEqual(["chat", null, "terminal"]);
  const before = s.writes;
  pruneTabs(s, new Set(["a", "c"]));
  expect(s.writes).toBe(before);

  const big = storage();
  for (let i = 0; i <= MAX_REMEMBERED_TABS; i++) rememberTab(big, `s${i}`, "chat");
  expect(rememberedTab(big, "s0")).toBeNull();
  expect(rememberedTab(big, "s1")).toBe("chat");
  rememberTab(big, "s1", "terminal");
  rememberTab(big, "new", "chat");
  expect(rememberedTab(big, "s1")).toBe("terminal");
  expect(rememberedTab(big, "s2")).toBeNull();
});

test("an unreadable stored value is reported and rewritten as an empty list", () => {
  const s = storage({ "devbox.tmuxTabs": "{not json" });
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  expect(rememberedTab(s, "a")).toBeNull();
  expect(warn).toHaveBeenCalled();
  expect(s.data["devbox.tmuxTabs"]).toBe("[]");
  warn.mockRestore();
});

test("storage that refuses (a private window) leaves the default", () => {
  const s: TabStorage = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  expect(rememberedTab(s, "a")).toBeNull();
  expect(() => rememberTab(s, "a", "chat")).not.toThrow();
  warn.mockRestore();
});
