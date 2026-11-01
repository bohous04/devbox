import { expect, test } from "bun:test";
import {
  canApprove, candidateLabel, formProblems, formReady, mergeBlocks, normalizeForm, prefill,
  refreshProvisionForm, requestState, requestSummary, selectCandidate, stateLabel, targetBlocks,
  type DbCandidate, type DbRequestRow,
} from "./dbRequestsView";

const row = (o: Partial<DbRequestRow> = {}): DbRequestRow => ({
  id: 2, ts: 0, session_id: "dev-apps-invoice-creator", project: "apps-invoice-creator", wanted: " billing ",
  why: "deploy approved cash-deposit migration", status: "pending", decided_at: null, note: null, ...o,
});
const target: DbCandidate = { id: "acme:dbuuid", instance: "acme", server: "acme", container: "dbuuid", engine: "postgres", name: "billing-db", db: "billing", environment: "production", application: "app-uuid", applicationName: "Billing", verified: true, matched: true };
const form = () => selectCandidate(prefill(row()), target);
const prepared = (): DbRequestRow => row({ state: "awaiting_approval", operationId: 19, blocks: [], plan: {
  entry: { name: "billing", server: "acme", engine: "postgres", db: "billing", hostPort: 15501, roUser: "billing_ro" },
  input: form(), changes: ["Create a restricted tunnel key", "Verify read-only access"],
} });

test("request summary carries identity and purpose without an unbounded reason", () => {
  expect(requestSummary(row({ wanted: "billing" }))).toContain("billing · apps-invoice-creator · deploy");
  expect(requestSummary(row({ why: "x".repeat(200) })).length).toBeLessThanOrEqual(120);
});

test("a project name is never treated as a server or SSH alias", () => {
  const f = prefill(row());
  expect(f.server).toBe("");
  expect(f.sshAlias).toBe("");
  expect(f.container).toBe("");
  expect(f.db).toBe("billing");
  expect(f.hostPort).toBe(0);
  expect(formReady(f).ok).toBe(false);
});

test("verified discovery supplies a real catalog target and readable environment", () => {
  expect(form().server).toBe("acme");
  expect(form().container).toBe("dbuuid");
  expect(candidateLabel(target)).toBe("billing-db · production · acme · Billing");
  expect(candidateLabel({ ...target, environment: "staging" })).toContain("staging");
  expect(candidateLabel(target)).not.toContain("app-uuid");
  expect(candidateLabel({ ...target, applicationName: undefined })).toContain("app-uuid");
  expect(formReady(form()).ok).toBe(true);
});

test("normalization trims every submitted string without changing boolean scope", () => {
  const normalized = normalizeForm({ ...form(), server: " acme ", container: " dbuuid ", roUser: " billing_ro ", opItem: " prod-ro billing ", write: true });
  expect(normalized.server).toBe("acme");
  expect(normalized.container).toBe("dbuuid");
  expect(normalized.roUser).toBe("billing_ro");
  expect(normalized.opItem).toBe("prod-ro billing");
  expect(normalized.write).toBe(true);
  expect(formReady(normalized).ok).toBe(true);
});

test("validation reports all invalid input together and permits automatic port assignment", () => {
  expect(formProblems({ ...form(), hostPort: 0 })).toEqual([]);
  const problems = formProblems({ ...form(), server: "bad server", container: "bad;container", roUser: "ro user", hostPort: 80 });
  expect(problems).toHaveLength(4);
  expect(problems.join(" ")).toContain("Container");
  expect(problems.join(" ")).toContain("Host port");
  expect(formReady({ ...form(), hostPort: 15500.5 }).ok).toBe(false);
});

test("write proposals are opt-in and require a separate write identity", () => {
  expect(form().write).toBe(false);
  expect(formReady({ ...form(), write: true, rwUser: "", rwOpItem: "" }).ok).toBe(false);
  expect(formReady({ ...form(), write: true }).ok).toBe(true);
});

test("approval requires a complete immutable plan and no blocks or unsaved edits", () => {
  expect(canApprove(prepared())).toBe(true);
  expect(canApprove(prepared(), true)).toBe(false);
  expect(canApprove({ ...prepared(), operationId: null })).toBe(false);
  expect(canApprove({ ...prepared(), plan: null })).toBe(false);
  expect(canApprove({ ...prepared(), blocks: [{ code: "missing_key", category: "configuration", message: "Missing tunnel key", action: "Create it in 1Password" }] })).toBe(false);
  for (const state of ["pending", "blocked", "executing", "verifying", "failed", "rejected", "ready"]) {
    expect(canApprove({ ...prepared(), state })).toBe(false);
  }
});

test("approval and legacy manual confirmation never imply verified access", () => {
  expect(requestState(row({ status: "approved" }))).toBe("verification_required");
  expect(stateLabel(row({ state: "executing" }))).toBe("Setting up on host");
  expect(stateLabel(row({ state: "verifying" }))).toBe("Verifying access");
  expect(stateLabel(row({ state: "ready" }))).toBe("Access verified");
});

test("reload restores prepared input and retains the exact scope", () => {
  const r = prepared();
  r.plan!.input = { ...form(), hostPort: 15505 };
  r.plan!.write = true;
  expect(prefill(r)).toMatchObject({ server: "acme", hostPort: 15505, write: true });
});

test("all distinct blocks remain visible without duplicate messages", () => {
  const key = { code: "missing_key", category: "configuration" as const, message: "Missing key", action: "Create key" };
  const denied = { code: "denied", category: "permission" as const, message: "Vault denies reads", action: "Grant access" };
  expect(mergeBlocks([key], [key, denied])).toEqual([key, denied]);
});

test("selected target scopes discovery blocks while retaining its failures and shared blockers", () => {
  const common = { code: "vault_unavailable", category: "connection" as const, message: "Vault unavailable", action: "Unlock" };
  const own = { ...common, code: "coolify_permission", instance: "acme", candidateId: target.id };
  const otherDatabase = { ...common, code: "server_mapping", instance: "acme", candidateId: "acme:other" };
  const otherInstance = { ...common, code: "server_mapping", instance: "infra" };
  const choice = { ...common, code: "target_choice", category: "decision" as const };
  const blocks = [common, own, otherDatabase, otherInstance, choice];
  expect(targetBlocks(blocks, target)).toEqual([common, own]);
  expect(targetBlocks(blocks)).toEqual(blocks);
  expect(targetBlocks(blocks, { ...target, id: "acme:other" })).toEqual([common, otherDatabase]);
});

test("merging identically worded discovery failures cannot erase the selected candidate error", () => {
  const own = { code: "coolify_permission", category: "permission" as const, message: "Permission denied", action: "Fix access", instance: "acme", candidateId: target.id };
  const otherDatabase = { ...own, candidateId: "acme:other" };
  const otherInstance = { ...own, instance: "infra", candidateId: "infra:other" };
  const merged = mergeBlocks([own], [own, otherDatabase, otherInstance]);
  expect(merged).toEqual([own, otherDatabase, otherInstance]);
  expect(targetBlocks(merged, target)).toEqual([own]);
});


test("requested SQL scope prefills the matching proposal roles without approving a plan", () => {
  expect(prefill(row({ requested_scope: "read" }))).toMatchObject({ write: false, migrations: false });
  expect(prefill(row({ requested_scope: "dml" }))).toMatchObject({ write: true, migrations: false });
  expect(prefill(row({ requested_scope: "migration" }))).toMatchObject({ write: true, migrations: true });
  expect(canApprove(row({ requested_scope: "migration" }))).toBe(false);
  const approvedReadPlan = { ...prepared(), requested_scope: "migration" as const };
  expect(prefill(approvedReadPlan)).toMatchObject({ write: false, migrations: false });
});


test("scope polling updates an unedited open form while retaining its verified target", () => {
  const current = form();
  expect(refreshProvisionForm(current, row({ requested_scope: "migration" }), false)).toMatchObject({
    server: "acme", container: "dbuuid", candidateId: target.id, write: true, migrations: true,
  });
  expect(refreshProvisionForm(current, row({ requested_scope: "migration" }), true)).toBe(current);
  expect(refreshProvisionForm(current, { ...prepared(), requested_scope: "migration" }, false).write).toBe(false);
  const promoted = { ...prepared(), requested_scope: "migration" as const, operationId: null,
    blocks: [{ code: "scope_changed", category: "decision" as const, message: "Scope increased", action: "Prepare again" }] };
  expect(refreshProvisionForm(current, promoted, false)).toMatchObject({ server: "acme", write: true, migrations: true });
});
