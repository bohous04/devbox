import { expect, spyOn, test } from "bun:test";
import { MAX_REMEMBERED_TABS, openTab, pruneTabs, rememberedTab, rememberTab, type TabStorage } from "./tmuxTab";

function storage(initial: Record<string, string> = {}): TabStorage & { data: Record<string, string> } {
  const data = { ...initial };
  return { data, getItem: (k) => data[k] ?? null, setItem: (k, v) => { data[k] = v; } };
}

test("a tmux session's tab is remembered per session; switching back is remembered too", () => {
  const s = storage();
  expect(rememberedTab(s, "a")).toBeNull();
  rememberTab(s, "a", "chat");
  rememberTab(s, "b", "terminal");
  expect(rememberedTab(s, "a")).toBe("chat");
  expect(rememberedTab(s, "b")).toBe("terminal");
  rememberTab(s, "a", "terminal");
  expect(rememberedTab(s, "a")).toBe("terminal");
});

test("the tab it opens on: the remembered one, else Chat; a remembered Chat it cannot read opens Terminal", () => {
  expect(openTab(null, true)).toBe("chat");
  expect(openTab("chat", true)).toBe("chat");
  expect(openTab("terminal", true)).toBe("terminal");
  // An agent the mirror cannot read: Terminal, the stored choice kept for later (openTab never writes).
  expect(openTab("chat", false)).toBe("terminal");
  expect(openTab(null, false)).toBe("chat");
});

test("sessions that no longer exist are pruned; the list is capped, the least recently chosen going first", () => {
  const s = storage();
  rememberTab(s, "a", "chat");
  rememberTab(s, "b", "chat");
  rememberTab(s, "c", "terminal");
  pruneTabs(s, new Set(["a", "c", "z"]));
  expect([rememberedTab(s, "a"), rememberedTab(s, "b"), rememberedTab(s, "c")]).toEqual(["chat", null, "terminal"]);
  const before = s.data["devbox.tmuxTabs"];
  pruneTabs(s, new Set(["a", "c"]));
  expect(s.data["devbox.tmuxTabs"]).toBe(before);

  const big = storage();
  for (let i = 0; i <= MAX_REMEMBERED_TABS; i++) rememberTab(big, `s${i}`, "chat");
  expect(rememberedTab(big, "s0")).toBeNull();
  expect(rememberedTab(big, "s1")).toBe("chat");
  // Choosing again makes it the most recent: it outlives the others.
  rememberTab(big, "s1", "terminal");
  rememberTab(big, "new", "chat");
  expect(rememberedTab(big, "s1")).toBe("terminal");
  expect(rememberedTab(big, "s2")).toBeNull();
});

test("an unreadable stored value is reported and started over, not thrown at the page", () => {
  const s = storage({ "devbox.tmuxTabs": "{not json" });
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  expect(rememberedTab(s, "a")).toBeNull();
  expect(warn).toHaveBeenCalled();
  rememberTab(s, "a", "chat");
  expect(rememberedTab(s, "a")).toBe("chat");
  warn.mockRestore();
});

test("storage that refuses (a private window) leaves the default", () => {
  const s: TabStorage = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  expect(rememberedTab(s, "a")).toBeNull();
  expect(() => rememberTab(s, "a", "chat")).not.toThrow();
  warn.mockRestore();
});
