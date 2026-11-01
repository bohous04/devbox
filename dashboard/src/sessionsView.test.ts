import { expect, test } from "bun:test";
import { agentSwitchError } from "./sessionsView";

// Swapping the agent returns failure as HTTP 200 too (like switch-account, see M1
// on the Switch account button) — without translating it into an error sentence ConfirmButton would stay silent.
// null = full success (throw nothing); partial success is reported too.
test("agentSwitchError: success → null, failures and stale panes → a sentence", () => {
  const pane = (target: string, outcome: string) => ({ target, outcome }) as never;
  expect(agentSwitchError({ ok: true, status: "switched", panes: [pane("main:0.0", "restarted")] }, "Codex")).toBeNull();
  expect(agentSwitchError({ ok: true, status: "unchanged", panes: [] }, "Codex")).toBeNull();
  const noAgent = agentSwitchError({ ok: false, status: "no-agent", panes: [] }, "Codex");
  expect(noAgent).toContain("No running agent");
  const failed = agentSwitchError({ ok: false, status: "failed", panes: [pane("main:0.0", "did-not-exit")] }, "Codex");
  expect(failed).toContain("Codex");
  expect(failed).toContain("did-not-exit");
  const partial = agentSwitchError({ ok: true, status: "switched", panes: [pane("main:0.0", "restarted"), pane("main-2:0.0", "did-not-exit")] }, "Codex");
  expect(partial).toContain("main-2:0.0");
});
