import { expect, test } from "bun:test";
import { OPERATIONS, validateParams } from "../src/operations";
import { setRestartProjects } from "../src/operations";

setRestartProjects(["shop"]);

test("an unknown operation is rejected", () => {
  expect(validateParams("rm-rf", {})).toEqual({ ok: false, error: "unknown operation: rm-rf" });
});

test("a missing required parameter is rejected", () => {
  expect(validateParams("deploy", {}).ok).toBe(false);
});

test("a parameter outside the allowed set is rejected", () => {
  expect(validateParams("restart-app", { project: "other-project" }).ok).toBe(false);
});

test("extra parameters are dropped, not smuggled through", () => {
  const allowed = "apps-invoice-creator";
  const r = validateParams("deploy", { project: allowed, extra: "; rm -rf /" });
  expect(r.ok).toBe(true);
  if (r.ok) expect(Object.keys(r.params)).toEqual(["project"]);
});

test("pattern validation rejects an invalid format", () => {
  const catalog = {
    mail: { summary: "x", needsApproval: true, params: { to: { required: true, pattern: /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i } } },
  };
  expect(validateParams("mail", { to: "this is not an email" }, catalog).ok).toBe(false);
  expect(validateParams("mail", { to: "a@b.cz" }, catalog).ok).toBe(true);
});

test("no catalog entry has a free-form command parameter", () => {
  // Safeguard against the broker degrading over time into "run this with that key".
  for (const [name, def] of Object.entries(OPERATIONS)) {
    for (const [p, d] of Object.entries(def.params)) {
      const freeForm = !d.oneOf && !d.pattern;
      expect(freeForm ? `${name}.${p} is unrestricted` : "ok").toBe("ok");
    }
  }
});


test("deploy accepts a dynamic project or a complete explicit Coolify target, resolved against trusted config later", () => {
  expect(validateParams("deploy", { project: " apps-invoice-creator " })).toEqual({ ok: true, params: { project: "apps-invoice-creator" } });
  expect(validateParams("deploy", { instance: " acme ", application: " app123 ", commit: "a".repeat(40), afterWrite: "7", idempotencyKey: "deploy:fixture" })).toEqual({ ok: true, params: { instance: "acme", application: "app123", commit: "a".repeat(40), afterWrite: "7", idempotencyKey: "deploy:fixture" } });
});

test("deploy rejects incomplete targets, commands, short commits and invalid prerequisite IDs", () => {
  for (const params of [{}, { instance: "acme" }, { application: "app123" }, { project: "fixture; rm -rf /" }, { project: "fixture", commit: "e0c38dc" }, { project: "fixture", afterWrite: "0" }, { project: "fixture", application: "$(command)" }]) expect(validateParams("deploy", params).ok).toBe(false);
});
