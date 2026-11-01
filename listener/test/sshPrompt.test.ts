import { expect, test } from "bun:test";
import { parseDialogAnswer, sshDialogScript } from "../src/sshPrompt";

const REQ = {
  id: "abc", title: "shop", why: "restart hermes", target: "root@1.2.3.4",
  cwd: "/workspace", project: "web", repo: "app",
};

test("dialog separates verified facts from what the agent claims", () => {
  const s = sshDialogScript(REQ);
  expect(s).toContain("web/app");
  expect(s).toContain("shop");
  expect(s).toContain("The agent claims");
  expect(s).toContain("restart hermes");
});

test("the target is an agent claim, not a verified fact — it is under the 'The agent claims' heading", () => {
  const s = sshDialogScript(REQ);
  expect(s.indexOf("Target:")).toBeGreaterThan(s.indexOf("The agent claims"));
  expect(s).toContain("Target: root@1.2.3.4");
});

test("without a target the dialog does not mention one", () => {
  const s = sshDialogScript({ ...REQ, target: null });
  expect(s).not.toContain("Target:");
});

test("dialog offers three choices", () => {
  const s = sshDialogScript(REQ);
  expect(s).toContain("Deny");
  expect(s).toContain("Approve");
  expect(s).toContain("Approve for 60 min");
});

test("quotes and backslashes in agent text do not break AppleScript", () => {
  const s = sshDialogScript({ ...REQ, why: 'rest"art \\ hermes' });
  expect(s).toContain('rest\\"art \\\\ hermes');
});

// Review finding: `esc()` mapped "\n" → " " over the WHOLE joined message string,
// so the dialog looked like one continuous line and the separation of verified facts
// from agent claims was visually non-existent (even though the substring/order tests
// above kept passing). The fix joins lines with AppleScript's `return` constant,
// not with a literal "\n" (which does not work inside a `"..."` literal).
test("lines are joined with the AppleScript return constant, not a literal \\n", () => {
  const s = sshDialogScript(REQ);
  expect(s).not.toContain("\n");
  expect(s).toContain('"Key: shop" & return & "Session: web/app"');
  expect(s).toContain('"The agent claims:" & return & "restart hermes" & return & "Target: root@1.2.3.4"');
});

// A newline INSIDE a single value (the agent-claimed `why`) is still mapped to a space,
// not to `return` — otherwise the agent could fake a line structure through `why`
// and pass its own text off as another "verified" dialog line.
test("a newline inside `why` does not become another & return & line", () => {
  const s = sshDialogScript({ ...REQ, why: "first line\nfake Key: foreign-key" });
  // Both "lines" end up in ONE AppleScript string literal (newline → space) —
  // not split by their own `& return &` like real dialog lines.
  expect(s).toContain('"first line fake Key: foreign-key"');
  expect(s).not.toContain('"first line" & return &');
});

test("answers map to decisions", () => {
  expect(parseDialogAnswer("button returned:Approve")).toEqual({ decision: "approve", grantMinutes: 0 });
  expect(parseDialogAnswer("button returned:Approve for 60 min")).toEqual({ decision: "approve", grantMinutes: 60 });
  expect(parseDialogAnswer("button returned:Deny")).toEqual({ decision: "deny", grantMinutes: 0 });
});

test("a closed or unknown dialog is not a decision", () => {
  expect(parseDialogAnswer("")).toBeNull();
  expect(parseDialogAnswer("gibberish")).toBeNull();
});

test("a request from a shared session says so in the title and body (final review I4)", () => {
  const s = sshDialogScript({ ...REQ, shared: true });
  expect(s).toContain('with title "Devbox: SSH key request from a shared session"');
  expect(s).toContain("web/app (from a shared session)");
  expect(s).toContain("may come from a terminal guest");
  expect(sshDialogScript(REQ)).not.toContain("shared");
});
