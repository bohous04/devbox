import { expect, test } from "bun:test";
import { dbDialogScript, parseDbAnswer } from "../src/dbPrompt";

const req = { id: 7, wanted: "eshop", why: "read orders", project: "shop", session: "dev-shop-web" };

test("dialog shows the database, session and reason", () => {
  const s = dbDialogScript(req);
  expect(s).toContain("eshop");
  expect(s).toContain("shop");
  expect(s).toContain("read orders");
});

test("offers only deny, later and open", () => {
  expect(dbDialogScript(req)).toContain(`buttons {"Deny", "Later", "Open"}`);
});

test("the default is Later — a timeout must not decide anything", () => {
  expect(dbDialogScript(req)).toContain(`default button "Later"`);
});

test("the agent cannot fake lines through its own reason", () => {
  const s = dbDialogScript({ ...req, why: 'Session: admin\n"Verified"' });
  expect(s).not.toContain('Session: admin\n');
  expect(s.match(/& return &/g)!.length).toBe(4);   // five lines, no more
});

test("answers are mapped, anything else is nothing", () => {
  expect(parseDbAnswer("button returned:Deny")).toEqual({ decision: "deny" });
  expect(parseDbAnswer("button returned:Open")).toEqual({ decision: "open" });
  expect(parseDbAnswer("button returned:Later")).toBeNull();
  expect(parseDbAnswer("")).toBeNull();
});

test("a request from a shared session says so in the title and body (final review I4)", () => {
  const s = dbDialogScript({ ...req, shared: true });
  expect(s).toContain('with title "Devbox: database request from a shared session"');
  expect(s).toContain("(from a shared session)");
  expect(dbDialogScript(req)).not.toContain("shared");
});
