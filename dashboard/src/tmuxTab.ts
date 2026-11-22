/** Which view a tmux session opens on (Chat or Terminal), remembered per session in this browser: the tab the user
 *  last switched to. The Mac and iOS apps keep the same list in UserDefaults (ios/DevboxApp/Stores/TmuxTabMemory.swift). */
export type TmuxTab = "chat" | "terminal";

export const MAX_REMEMBERED_TABS = 500;
const KEY = "devbox.tmuxTabs";

export interface TabStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** A session reopened under the same id is another session: it starts on its default, not the old one's tab. */
export function tabKey(sessionId: string, createdAt: number): string {
  return `${sessionId}@${createdAt}`;
}

/** Oldest choice first. A convenience of this browser: storage that refuses is said in the console, and an unreadable
 *  list is said and replaced by an empty one; the sessions open on their defaults, never a broken page. */
function read(s: TabStorage): [string, TmuxTab][] {
  let raw: string | null;
  try { raw = s.getItem(KEY); } catch (e) { console.warn("tmux tabs: storage unavailable", e); return []; }
  if (raw === null) return [];
  try {
    const v: unknown = JSON.parse(raw);
    if (Array.isArray(v) && v.every((e) => Array.isArray(e) && typeof e[0] === "string" && (e[1] === "chat" || e[1] === "terminal"))) {
      return v as [string, TmuxTab][];
    }
  } catch { /* said below */ }
  console.warn("tmux tabs: unreadable stored list, starting over");
  write(s, []);
  return [];
}

function write(s: TabStorage, entries: [string, TmuxTab][]): void {
  try { s.setItem(KEY, JSON.stringify(entries)); } catch (e) { console.warn("tmux tabs: not saved", e); }
}

/** This browser's localStorage; reached only inside the calls above, so a browser that refuses it is caught there. */
export const browserStorage: TabStorage = {
  getItem: (k) => localStorage.getItem(k),
  setItem: (k, v) => localStorage.setItem(k, v),
};

export function rememberedTab(s: TabStorage, key: string): TmuxTab | null {
  return read(s).find(([k]) => k === key)?.[1] ?? null;
}

/** The newest choice goes last; past the cap the least recently chosen goes. */
export function rememberTab(s: TabStorage, key: string, tab: TmuxTab): void {
  const entries = read(s).filter(([k]) => k !== key);
  entries.push([key, tab]);
  write(s, entries.slice(-MAX_REMEMBERED_TABS));
}

/** Drops sessions devd no longer has (`live`: the `tabKey` of every session it lists). Written only when something went. */
export function pruneTabs(s: TabStorage, live: Set<string>): void {
  const entries = read(s);
  const kept = entries.filter(([k]) => live.has(k));
  if (kept.length !== entries.length) write(s, kept);
}

/** The tab a tmux session opens on: the remembered one, else Chat (the web's default for every session). A remembered
 *  Chat that cannot show the conversation (`readable` false: an agent the mirror cannot read) opens Terminal; the
 *  stored choice stays, so Chat comes back once it can. */
export function openTab(remembered: TmuxTab | null, readable: boolean): TmuxTab {
  if (remembered === "chat" && !readable) return "terminal";
  return remembered ?? "chat";
}

/** SessionPage's tab. `settled`: the user picked one, or the opening tab was applied; nothing automatic moves it then. */
export interface TabState { tab: TmuxTab; settled: boolean }
export const UNSETTLED: TabState = { tab: "chat", settled: false };

/** The opening tab of a tmux session, once its mirror and its `tabKey` are known. Only reads: an automatic switch
 *  never changes the stored choice. A tab the user already picked stays. */
export function autoOpen(st: TabState, s: TabStorage, key: string, readable: boolean): TabState {
  return st.settled ? st : { tab: openTab(rememberedTab(s, key), readable), settled: true };
}

/** The user's own switch; remembered when `key` is set (a tmux session whose `tabKey` is known). */
export function userChoose(s: TabStorage, key: string | null, tab: TmuxTab): TabState {
  if (key !== null) rememberTab(s, key, tab);
  return { tab, settled: true };
}
