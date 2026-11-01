import { expect, test } from "bun:test";
import { SHARE_PRESETS, TAINT_ACTION, TAINT_MESSAGE, presetMinutes, shareWarning, shareExpiryLabel, taintedWithoutShare } from "./shareView";

test("presets → minutes (30, 60, 240, 480, 1440)", () => {
  expect(SHARE_PRESETS.map((p) => p.label)).toEqual(["30 min", "1 h", "4 h", "8 h", "24 h"]);
  expect(SHARE_PRESETS.map((p) => p.minutes)).toEqual([30, 60, 240, 480, 1440]);
  expect(presetMinutes("4 h")).toBe(240);
  expect(presetMinutes("24 h")).toBe(1440);
  expect(presetMinutes("nesmysl")).toBeNull();
});

test("expiry time: HH:MM today, with a date otherwise", () => {
  const now = new Date(2026, 9, 19, 10, 5).getTime();
  expect(shareExpiryLabel(new Date(2026, 9, 19, 14, 7).getTime(), now)).toBe("14:07");
  expect(shareExpiryLabel(new Date(2026, 9, 20, 9, 0).getTime(), now)).toBe("10/20 09:00");
});

test("the warning contains the expiry time and the exact text", () => {
  const now = new Date(2026, 9, 19, 10, 0).getTime();
  expect(shareWarning(new Date(2026, 9, 19, 10, 30).getTime(), now)).toBe(
    "Anyone with the link gets full terminal access to this session until 10:30 — they can see the code and may obtain your AI account logins (Claude, Codex). Share only with people you trust.",
  );
});

test("tainted sessions without a live share — text and action as specified", () => {
  expect(TAINT_MESSAGE).toBe("Sharing ended — the session stays restricted until you rebuild it");
  expect(TAINT_ACTION).toBe("Rebuild session");
  const sessions = [{ id: "a", tainted: true }, { id: "b", tainted: true }, { id: "c", tainted: false }, { id: "d" }, { id: "e", tainted: true }];
  const shares = [{ session_id: "b", expires_at: 2000 }, { session_id: "e", expires_at: 500 }];
  expect(taintedWithoutShare(sessions, shares, 1000).map((s) => s.id)).toEqual(["a", "e"]);
});
