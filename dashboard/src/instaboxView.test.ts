import { expect, test } from "bun:test";
import { instaboxAgentBlock } from "./newSession";
import { capacityLabel, hostDisabledReason, jobErrorText, JOB_STEP_LABEL, reconnectLink, refreshDelayMs, shouldRevokeOnClose, type IbxStatusDto } from "./instaboxView";

const st: IbxStatusDto = { enabled: true, ok: true, machines: 2, devboxMachines: 1, maxMachines: 5, storedBytes: 0, maxStoredBytes: 1, base: { snapshotId: "sn", builtAt: 1, stale: false }, orphans: [], lost: [] };

test("hostDisabledReason: R3 — an existing repo session does not block InstaBox", () => {
  expect(hostDisabledReason({ enabled: false }, false)).toBe("InstaBox is not configured");
  expect(hostDisabledReason({ ...st, ok: false, error: "x" }, false)).toBe("InstaBox API is unavailable");
  expect(hostDisabledReason(st, true)).toBe("claudeSolo runs only on the VPS");
  expect(hostDisabledReason({ ...st, base: null }, false)).toBe("Build the InstaBox base first");
  expect(hostDisabledReason({ ...st, machines: 5 }, false)).toBe("InstaBox 5/5 — stop or delete a machine");
  expect(hostDisabledReason(st, false)).toBeNull();
});

test("hostDisabledReason: proxy agents (claude-gpt/grok/gemini/openrouter) and Antigravity run only on the VPS", () => {
  expect(hostDisabledReason(st, false, instaboxAgentBlock("claude-gpt"))).toBe("Proxy agents run only on the VPS");
  expect(hostDisabledReason(st, false, instaboxAgentBlock("antigravity"))).toBe("Antigravity runs only on the VPS");
  expect(hostDisabledReason(st, false, instaboxAgentBlock("codex"))).toBeNull();
  expect(hostDisabledReason(st, false, null)).toBeNull();
  // The check order matches POST /api/sessions in devd/src/api.ts: solo before agent.
  expect(hostDisabledReason(st, true, instaboxAgentBlock("antigravity"))).toBe("claudeSolo runs only on the VPS");
  // An API outage and a missing base must report their own cause, not the agent.
  expect(hostDisabledReason({ enabled: false }, false, instaboxAgentBlock("claude-gpt"))).toBe("InstaBox is not configured");
});

test("capacityLabel, steps and job error", () => {
  expect(capacityLabel(st)).toBe("InstaBox 2/5");
  expect(JOB_STEP_LABEL.volumes).toBe("Copying logins and settings");
  expect(jobErrorText("clone", "repository not found")).toBe("Cloning repo: repository not found");
  expect(jobErrorText("weird")).toBe("weird: failed");
});

test("refreshDelayMs: 60 s before expiry, min 5 s", () => {
  expect(refreshDelayMs(1_000_000 + 600_000, 1_000_000)).toBe(540_000);
  expect(refreshDelayMs(1_000_000 + 30_000, 1_000_000)).toBe(5_000);
});

test("shouldRevokeOnClose: invalidate the control link only during active control", () => {
  expect(shouldRevokeOnClose(true)).toBe(true);
  expect(shouldRevokeOnClose(false)).toBe(false);
});

test("reconnectLink (M7): a pre-refreshed link only while still valid, otherwise the modal asks for a new one", () => {
  const l = { url: "https://dashboard.instabox.sh/stream/m/2", expiresAt: 1_000_000 + 540_000 };
  expect(reconnectLink(l, 1_000_000)).toBe(l);
  expect(reconnectLink(l, l.expiresAt - 4_000)).toBeNull();
  expect(reconnectLink(null, 1_000_000)).toBeNull();
});
