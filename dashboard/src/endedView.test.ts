import { expect, test } from "bun:test";
import type { EndedSession } from "../../shared/ended";
import type { InboxItem } from "../../shared/thread";
import { continueLabel, endedAttachmentUrl, endedHref, endedSecondLine, endedTitle, settledShelf, upsertEnded } from "./endedView";

const ended = (id: string, endedAt: number, over: Partial<EndedSession> = {}): EndedSession => ({
  id, sessionId: "dev-acme-app", runtime: "chat", title: "acme/app", folder: "acme", project: "acme", repo: "app", agent: "claude",
  branch: null, topic: null, lastText: null, endedAt, continueMode: "handoff", ...over,
});
const settled = (sessionId: string, since: number): InboxItem => ({
  sessionId, runtime: "chat", title: sessionId, project: "acme", repo: "app", agent: "claude",
  attention: { section: "settled", reason: null, since }, lastText: null,
});

test("upsertEnded adds or replaces by id, and a removal drops the row", () => {
  const a = ended("a", 1);
  expect(upsertEnded([], a)).toEqual([a]);
  expect(upsertEnded([a], { ...a, title: "x" })).toEqual([{ ...a, title: "x" }]);
  expect(upsertEnded([a, ended("b", 2)], { id: "a", removed: true }).map((e) => e.id)).toEqual(["b"]);
});

test("the Settled shelf mixes settled sessions and ended transcripts, newest first", () => {
  const rows = settledShelf([settled("s-old", 1), settled("s-new", 30)], [ended("e-mid", 20), ended("e-new", 40)]);
  expect(rows.map((r) => (r.kind === "session" ? r.item.sessionId : r.ended.id))).toEqual(["e-new", "s-new", "e-mid", "s-old"]);
});

test("the button says what continue will do", () => {
  expect(continueLabel("resume")).toBe("Continue in a new session (resume)");
  expect(continueLabel("handoff")).toBe("Start a new session with this chat (handoff)");
});

test("an ended row is titled like a session row and says where it ran", () => {
  expect(endedTitle(ended("e", 1, { title: "Login fix" }))).toBe("Login fix");
  expect(endedTitle(ended("e", 1, { topic: "Fix the login form" }))).toBe("Fix the login form");
  expect(endedSecondLine(ended("e", 1, { branch: "feat/x" }))).toBe("acme/app · feat/x");
  expect(endedHref(ended("dev-a b-1", 1))).toBe("/ended/dev-a%20b-1");
});

test("a transcript's images come from the ended session's archive", () => {
  expect(endedAttachmentUrl("dev-a-1", "/inbox/dev-a/0b4e.png")).toBe("/api/ended/dev-a-1/attachments/0b4e.png");
});
