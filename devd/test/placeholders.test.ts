import { expect, test } from "bun:test";
import { openDb } from "../src/db";
import { createPlaceholderStore } from "../src/placeholders";

test("a placeholder is per session and per instance", () => {
  const s = createPlaceholderStore(openDb(":memory:"));
  const a = s.issue("dev-p-r", "infra");
  expect(s.lookup(a)).toEqual({ instance: "infra", session: "dev-p-r" });
});

test("a placeholder looks like a placeholder and differs every time", () => {
  const s = createPlaceholderStore(openDb(":memory:"));
  const a = s.issue("dev-p-r", "infra");
  expect(a.startsWith("devbox-")).toBe(true);
  expect(a).not.toBe(s.issue("dev-p-r", "infra"));
});

test("revoking a session invalidates its placeholders and leaves others alone", () => {
  const s = createPlaceholderStore(openDb(":memory:"));
  const mine = s.issue("dev-a-x", "infra");
  const other = s.issue("dev-b-y", "infra");
  s.revoke("dev-a-x");
  expect(s.lookup(mine)).toBeUndefined();
  expect(s.lookup(other)).toBeDefined();
});

test("all() returns a map in the shape gitProxy expects", () => {
  const s = createPlaceholderStore(openDb(":memory:"));
  const a = s.issue("dev-a-x", "infra");
  expect(s.all()[a]).toEqual({ instance: "infra", session: "dev-a-x" });
});

// Regression: placeholders lived only in memory, so a devd restart broke git in ALL running
// sessions — the container had a placeholder in its file that devd no longer knew (403).
test("a placeholder survives a devd restart", () => {
  const db = openDb(":memory:");
  const a = createPlaceholderStore(db).issue("dev-p-r", "infra");
  const afterRestart = createPlaceholderStore(db);   // a new instance over the same database
  expect(afterRestart.lookup(a)).toEqual({ instance: "infra", session: "dev-p-r" });
});

test("a repeated issue for the same session does not revoke the old placeholders", () => {
  const s = createPlaceholderStore(openDb(":memory:"));
  const first = s.issue("dev-a-x", "infra");
  s.issue("dev-a-x", "infra");
  expect(s.lookup(first)).toBeDefined();
});
