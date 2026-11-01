import { expect, spyOn, test } from "bun:test";
import { api, ApiError } from "./api";
import { actionErrorMessage, grantDurationLabel, GRANT_MINUTE_PRESETS, maxGrantMinutes, parseGrantMinutes, sshTargetLabel } from "./sshApprovalsView";

const now = Date.UTC(2026, 8, 11);

test("all presets and a custom duration above the former limit are valid", () => {
  for (const minutes of [...GRANT_MINUTE_PRESETS, 1, 73, 1440, 525600]) {
    expect(parseGrantMinutes(String(minutes), now)).toBe(minutes);
  }
  expect(parseGrantMinutes(" 90 ", now)).toBe(90);
});

test("an invalid custom duration never falls back to a one-time or permanent approval", () => {
  for (const value of ["", " ", "0", "-1", "1.5", "60min", "1e3", "0x10", "Infinity", "NaN", "permanent"]) {
    expect(parseGrantMinutes(value, now)).toBeNull();
  }
});

test("the duration must not exceed the range of a valid timestamp", () => {
  const max = maxGrantMinutes(now);
  expect(parseGrantMinutes(String(max), now)).toBe(max);
  expect(parseGrantMinutes(String(max + 1), now)).toBeNull();
  expect(parseGrantMinutes("9007199254740992", now)).toBeNull();
});

test("a permanent grant shows as forever and a timed grant keeps counting down", () => {
  expect(grantDurationLabel({ grant_permanent: 1, grant_until: null }, now)).toBe("Forever");
  expect(grantDurationLabel({ grant_permanent: 0, grant_until: now + 60_001 }, now)).toBe("2 min left");
  expect(grantDurationLabel({ grant_permanent: 0, grant_until: now - 1 }, now)).toBe("0 min left");
});

test("the API distinguishes one-time, timed and explicitly permanent approval", async () => {
  const fetchMock = spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json({ ok: true }))
    .mockResolvedValueOnce(Response.json({ ok: true }))
    .mockResolvedValueOnce(Response.json({ ok: true }));
  try {
    await api.sshApprove("once");
    await api.sshApprove("custom", 173);
    await api.sshApprove("forever", 0, true);
    expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
      { by: "dashboard", grantMinutes: 0 },
      { by: "dashboard", grantMinutes: 173 },
      { by: "dashboard", grantMinutes: 0, grantPermanent: true },
    ]);
  } finally {
    fetchMock.mockRestore();
  }
});

test("sshTargetLabel: known server combines alias and resolved target", () => {
  expect(sshTargetLabel({ server: "shop-root", target: "root@192.0.2.11:22" })).toBe("shop-root · root@192.0.2.11:22");
});

test("sshTargetLabel: target without a matching config server", () => {
  expect(sshTargetLabel({ server: null, target: "root@1.2.3.4:22" })).toBe("unknown server: root@1.2.3.4:22");
});

test("sshTargetLabel: no target at all", () => {
  expect(sshTargetLabel({ server: null, target: null })).toBe("no target");
});

test("409 (another tab/mac/phone decided first) is suppressed — it is not an error", () => {
  expect(actionErrorMessage(new ApiError("request is no longer open", 409))).toBeNull();
});

test("423 (locked vault) and other HTTP errors are shown with the text unchanged", () => {
  expect(actionErrorMessage(new ApiError("vault is locked", 423))).toBe("vault is locked");
  expect(actionErrorMessage(new ApiError("request has no live grant to revoke", 409 + 1))).toBe("request has no live grant to revoke");
});

test("a generic error (network, throw) is shown via its .message", () => {
  expect(actionErrorMessage(new Error("network down"))).toBe("network down");
});

test("a non-Error value is at least shown, it does not vanish silently", () => {
  expect(actionErrorMessage("plain string")).toBe("plain string");
});
