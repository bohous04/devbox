import { expect, test } from "bun:test";
import { eventLabel, eventDetail, sessionShort } from "./eventLabels";
import { LOG_GROUPS } from "./logView";

test("eventLabel: known type has a label + kind, unknown falls back", () => {
  expect(eventLabel("agent_done")).toEqual({ label: "Claude finished the work", kind: "ok" });
  expect(eventLabel("agent_stuck").kind).toBe("danger");
  expect(eventLabel("schedule_run").label).toContain("Scheduled");
  expect(eventLabel("unknown_type")).toEqual({ label: "unknown_type", kind: "info" });
});
test("eventDetail pulls out known keys, empty → ''", () => {
  expect(eventDetail(JSON.stringify({ schedule: "Nightly bump", branch: "auto/x-1" }))).toContain("Nightly bump");
  expect(eventDetail(JSON.stringify({ kind: "permission" }))).toContain("permission");
  expect(eventDetail(null)).toBe("");
  expect(eventDetail("invalid{")).toBe("");
});
test("sessionShort: dev-prefix → project/repo, null → system", () => {
  expect(sessionShort("dev-shop-cms")).toBe("shop/cms");
  expect(sessionShort(null)).toBe("system");
});
// Switching agents has two forms: recreating the container on open (agent-switch)
// and a live swap on a running session (agent-switch-live). eventDetail already handles
// the from/to detail (the "from"/"to" keys are in the list).
test("agent-switch events have a human label", () => {
  expect(eventLabel("agent-switch").label).toContain("Agent");
  expect(eventLabel("agent-switch-live").label).toContain("Agent");
  expect(eventDetail(JSON.stringify({ from: "claude-openrouter", to: "claude" }))).toBe("claude-openrouter · claude");
});

test("critic events have labels", () => {
  expect(eventLabel("critic_pass")).toEqual({ label: "Critic approved the work", kind: "ok" });
  expect(eventLabel("critic_block").kind).toBe("warn");
  expect(eventLabel("critic_giveup").kind).toBe("warn");
  expect(eventLabel("critic_error").kind).toBe("danger");
  expect(eventLabel("critic_toggle").label).toBe("Critic toggled");
});

test("cc_* events have labels and the right severity", () => {
  expect(eventLabel("cc_upgraded").kind).toBe("ok");
  expect(eventLabel("cc_skipped").kind).toBe("info");
  expect(eventLabel("cc_restart_failed").kind).toBe("warn");
  expect(eventLabel("cc_upgrade_failed").kind).toBe("danger");
  expect(eventLabel("cc_upgraded").label).not.toBe("cc_upgraded");
});

test("eventDetail shows versions and counts from cc_upgraded", () => {
  const d = eventDetail(JSON.stringify({ from: "2.1.207", to: "2.1.220", restarted: 2, stuck: 0 }));
  expect(d).toContain("2.1.207");
  expect(d).toContain("2.1.220");
});

test("prod-db events have a human label, not the raw type", () => {
  // The log filters them as the "Production DB" group — without a label the bare
  // `prod_write_proposed` would show, which was exactly the confusion in Activity.
  for (const t of ["prod_db_access", "prod_write_proposed", "prod_write_executed", "prod_write_rejected"]) {
    expect(eventLabel(t).label).not.toBe(t);
  }
  expect(eventLabel("prod_write_proposed").kind).toBe("warn");
  expect(eventLabel("prod_write_executed").kind).toBe("ok");
});

test("every type from the logView groups has a label", () => {
  for (const g of LOG_GROUPS) {
    for (const t of g.types) expect(eventLabel(t).label).not.toBe(t);
  }
});

test("ssh_* events have labels and kind only from existing EventKind values", () => {
  // EventKind is only "info" | "ok" | "warn" | "danger" — no "waiting"/"idle".
  for (const t of ["ssh_key_requested", "ssh_key_approved", "ssh_key_denied", "ssh_key_access", "ssh_key_bypass", "ssh_grant_revoked"]) {
    const { label, kind } = eventLabel(t);
    expect(label).not.toBe(t);
    expect(["info", "ok", "warn", "danger"]).toContain(kind);
  }
  expect(eventLabel("ssh_key_requested").kind).toBe("warn");
  expect(eventLabel("ssh_key_approved").kind).toBe("ok");
  expect(eventLabel("ssh_key_denied").kind).toBe("danger");
  expect(eventLabel("ssh_key_bypass").kind).toBe("danger");
  // Rewrite of the original "SSH key access" — a new, more precise wording, not a duplicate key in LABELS.
  expect(eventLabel("ssh_key_access").label).toBe("SSH key handed to ssh-agent");
});
