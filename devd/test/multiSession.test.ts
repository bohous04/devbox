import { expect, test } from "bun:test";
import { existingSessionId, nextSessionId } from "../src/sessions";
import { insertSession, openDb } from "../src/db";

const ROW = {
  folder: "acme", project: "portal", repo: "web", container: "x", port_base: 40100,
  status: "running" as const, solo: 0 as const, created_at: 0, last_active_at: 0, important: 0 as const,
};

test("the first session in a repo keeps the current id shape", () => {
  const db = openDb(":memory:");
  expect(nextSessionId(db, "portal", "web")).toBe("dev-portal-web");
});

// Backward compatibility is what matters here: running sessions on the VPS carry today's id
// in the event history, metrics and container name. Renumbering them would mean
// a live migration.
test("further sessions get an ordinal suffix starting at two", () => {
  const db = openDb(":memory:");
  insertSession(db, { ...ROW, id: "dev-portal-web" });
  expect(nextSessionId(db, "portal", "web")).toBe("dev-portal-web-2");
  insertSession(db, { ...ROW, id: "dev-portal-web-2", port_base: 40105 });
  expect(nextSessionId(db, "portal", "web")).toBe("dev-portal-web-3");
});

// A gap left by an ended session should be filled, not skipped — otherwise the numbers run off to
// absurd heights and nothing ever brings them back.
test("a freed number is reused", () => {
  const db = openDb(":memory:");
  insertSession(db, { ...ROW, id: "dev-portal-web" });
  insertSession(db, { ...ROW, id: "dev-portal-web-3", port_base: 40110 });
  expect(nextSessionId(db, "portal", "web")).toBe("dev-portal-web-2");
});

test("repos with similar names are not confused", () => {
  const db = openDb(":memory:");
  insertSession(db, { ...ROW, id: "dev-portal-web" });
  expect(nextSessionId(db, "portal", "web-api")).toBe("dev-portal-web-api");
});

// An ended session may leave its working directory on disk (for conversation recovery).
// A new session would move into it along with someone else's files, so such a number is skipped.
test("a number with a leftover working directory is skipped", () => {
  const db = openDb(":memory:");
  const leftovers = new Set(["dev-portal-web", "dev-portal-web-2"]);
  expect(nextSessionId(db, "portal", "web", (id) => leftovers.has(id))).toBe("dev-portal-web-3");
  insertSession(db, { ...ROW, id: "dev-portal-web-3" });
  expect(nextSessionId(db, "portal", "web", (id) => leftovers.has(id))).toBe("dev-portal-web-4");
});

test("existingSessionId with a filter: a scheduled run skips the repo's InstaBox session", () => {
  const db = openDb(":memory:");
  insertSession(db, { ...ROW, id: "dev-portal-web", status: "stopped", host: "instabox", instabox_machine_id: "m_1" });
  expect(existingSessionId(db, "portal", "web")).toBe("dev-portal-web");
  expect(existingSessionId(db, "portal", "web", (s) => (s.host ?? "vps") === "vps")).toBeNull();
  insertSession(db, { ...ROW, id: "dev-portal-web-2", port_base: 40105, status: "stopped" });
  expect(existingSessionId(db, "portal", "web", (s) => (s.host ?? "vps") === "vps")).toBe("dev-portal-web-2");
});
