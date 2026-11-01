// Isolated browser regression: every API response is a fixture. No devd or production DB is contacted.
// Run Vite locally, then: PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node tools/db-onboarding-ui-qa.mjs
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const origin = process.env.DB_UI_ORIGIN || "http://127.0.0.1:4179";
assert.match(origin, /^http:\/\/(127\.0\.0\.1|localhost):\d+$/);
const output = process.env.DB_UI_OUTPUT || "/tmp/devbox-db-onboarding-ui";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH });
const page = await browser.newPage({ viewport: { width: 1440, height: 1080 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const base = { id: 2, ts: Date.now(), session_id: "dev-apps-invoice-creator", project: "apps-invoice-creator", wanted: "billing", why: "Prepare access for the approved cash-deposit deployment", status: "pending", decided_at: null, note: null, state: "pending", operationId: null, plan: null, blocks: [], nextAction: "Discover and prepare the production target." };
const target = { id: "acme:dbuuid", instance: "acme", server: "acme", container: "dbuuid", engine: "postgres", name: "billing-db", db: "billing", environment: "production", application: "app-uuid", applicationName: "Billing", verified: true, matched: true };
const unrelatedDiscoveryBlocks = [
  { code: "server_mapping", category: "configuration", instance: "infra", candidateId: "infra:other", message: "infra unrelated database has no server mapping.", action: "Map its server." },
  { code: "server_mapping", category: "configuration", instance: "acme", candidateId: "acme:other", message: "Another acme database has no server mapping.", action: "Map its server." },
];
const blocks = [
  { code: "missing_key", category: "configuration", message: "Dedicated tunnel key is missing.", action: "The approved host operation will create the restricted key when vault access is available." },
  { code: "op_unavailable", category: "connection", message: "1Password integration is unavailable.", action: "Unlock the host vault. This request resumes automatically from this step." },
  { code: "ddl_denied", category: "permission", message: "Migration role cannot own this schema.", action: "Review the database ownership configuration before approving a migration." },
];
let rows = [structuredClone(base)];
let candidates = [target];
let prepareCount = 0, approveCount = 0, resumeCount = 0, sqlExecutionCount = 0;
let writes = [], extraOperations = [];
let approvalFails = true;
let lastPrepare;
let holdDiscovery = false, releaseDiscovery;
await page.route("**/api/**", async (route) => {
  const url = new URL(route.request().url());
  assert.equal(url.origin, origin, "fixture must not contact another origin");
  const path = url.pathname;
  let payload = [], status = 200;
  if (path === "/api/vault") payload = { locked: false };
  else if (path === "/api/stats/live") payload = { sessions: [], disk: { usedBytes: 0, totalBytes: 1 } };
  else if (path === "/api/config") payload = {};
  else if (path === "/api/health") payload = { ok: true, version: "isolated-ui-fixture" };
  else if (path === "/api/prod-db/writes") payload = writes;
  else if (path === "/api/prod-db/writes/12/preview") payload = { rows: 0, note: "SQL has not run. Review the exact statement, target and scope before approval." };
  else if (path === "/api/prod-db/writes/12/approve") { sqlExecutionCount += 1; writes[0] = { ...writes[0], status: "executed", result: "Migration verified", error: null }; payload = { rows: 0, note: "Migration verified" }; }
  else if (path === "/api/prod-db/requests") payload = structuredClone(rows);
  else if (path.endsWith("/discovery")) {
    const captured = structuredClone(candidates);
    if (holdDiscovery && path.includes("/2/")) await new Promise((resolve) => { releaseDiscovery = resolve; });
    payload = { candidates: path.includes("/3/") ? [{ ...target, id: "other:db", server: "other", name: "Other database", matched: true }] : captured, blocks: unrelatedDiscoveryBlocks };
  } else if (path.endsWith("/prepare")) {
    prepareCount += 1;
    lastPrepare = route.request().postDataJSON();
    rows[0] = { ...rows[0], state: "blocked", blocks, nextAction: "Resolve the host setup blocks; checks resume automatically.", plan: {
      entry: { name: "billing", server: "acme", engine: "postgres", db: "billing", hostPort: 15503, roUser: "billing_ro" },
      input: { container: "dbuuid", db: "billing", engine: "postgres", roUser: "billing_ro", hostPort: 15503, opItem: "prod-ro billing", rwUser: "billing_rw", rwOpItem: "prod-rw billing" },
      write: lastPrepare.write, migrations: lastPrepare.migrations, changes: ["Create a dedicated restricted tunnel key in 1Password.", "Install its public key for local TCP forwarding only.", "Provision SELECT-only access and separate write and migration roles.", "Verify the tunnel, permissions and catalog before reporting success."],
    } };
    payload = rows[0];
  } else if (path.endsWith("/approve")) {
    approveCount += 1;
    if (approvalFails) { status = 503; payload = { error: "SSH broker temporarily unavailable" }; }
    else { rows[0] = { ...rows[0], state: "executing", step: "Installing restricted public key" }; payload = { status: "approved" }; }
  } else if (path.endsWith("/resume")) {
    resumeCount += 1;
    rows[0] = { ...rows[0], state: "verifying", blocks: [], step: "Verifying tunnel and role permissions" }; payload = rows[0];
  } else if (path.endsWith("/reject")) {
    rows[0] = { ...rows[0], status: "rejected", state: "rejected", blocks: [] }; payload = { ok: true };
  } else if (/\/requests\/\d+$/.test(path)) payload = rows.find((r) => r.id === Number(path.split("/").at(-1)));
  else if (path === "/api/operations") payload = extraOperations.length ? extraOperations : rows[0].operationId ? [{ id: 19, ts: Date.now(), session_id: base.session_id, op: "db-onboard", params: JSON.stringify({ requestId: "2" }), status: "pending", decided_at: null, result: null, error: null }] : [];
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(payload) });
});
const card = () => page.locator("#db-request-2");
const awaitText = (text) => card().getByText(text, { exact: true }).waitFor();
const waitPoll = () => page.waitForResponse((r) => r.url().endsWith("/api/prod-db/requests"));
try {
  await page.goto(`${origin}/#/operations?request=2`);
  await card().getByLabel("Matched database").waitFor();
  assert.equal(await card().getByLabel("Matched database").inputValue(), target.id);
  assert.equal(await card().getByLabel("Matched database").locator("option:checked").textContent(), "billing-db · production · acme · Billing");
  assert.equal(await card().getByText("Setup blocks", { exact: true }).count(), 0, "unrelated discovery failures must not block the selected target");
  assert.equal(await card().locator("details").getAttribute("open"), null);
  assert.equal(await card().getByRole("button", { name: "Show command" }).count(), 0);
  assert.equal(await card().getByRole("button", { name: /I ran it/ }).count(), 0);
  await card().getByText("Advanced settings", { exact: true }).click();
  await card().getByText("Application: Billing · UUID app-uuid", { exact: true }).waitFor();
  assert.equal(await card().getByLabel("Catalog server").inputValue(), "acme");
  await card().getByLabel("Catalog server").fill(" acme ");
  await card().getByLabel("Catalog server").blur();
  assert.equal(await card().getByLabel("Catalog server").inputValue(), "acme");
  await card().getByText("Advanced settings", { exact: true }).click();
  await card().getByRole("checkbox", { name: /^Enable production write proposals/ }).check();
  await card().getByRole("checkbox", { name: /^Enable schema migration proposals/ }).check();
  await page.screenshot({ path: `${output}/target-desktop.png`, fullPage: true });
  await card().getByRole("button", { name: "Prepare onboarding", exact: true }).evaluate((button) => { button.click(); button.click(); });
  await awaitText("Setup blocks");
  assert.equal(prepareCount, 1, "rapid clicks must not duplicate preparation");
  assert.equal(lastPrepare.server, "acme");
  assert.equal(lastPrepare.migrations, true);
  assert.equal(await card().getByRole("button", { name: "Approve and set up" }).count(), 0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${output}/blocks-mobile.png`, fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false, "mobile page must not overflow");
  for (const block of blocks) assert.equal(await card().getByText(block.message, { exact: false }).count(), 1);
  rows[0] = { ...rows[0], state: "awaiting_approval", operationId: 19, blocks: [], nextAction: "Approve the prepared setup in Operations." };
  await card().getByRole("button", { name: "Approve and set up" }).waitFor({ timeout: 10000 });
  assert.equal(await card().getByRole("checkbox", { name: /^Enable schema migration proposals/ }).isChecked(), true);
  assert.equal(await card().getByRole("checkbox", { name: /^Enable schema migration proposals/ }).isDisabled(), true);
  await page.setViewportSize({ width: 1440, height: 1080 });
  await page.screenshot({ path: `${output}/prepared-desktop.png`, fullPage: true });
  await card().getByRole("button", { name: "Approve and set up" }).click();
  await awaitText("SSH broker temporarily unavailable");
  await waitPoll();
  await awaitText("SSH broker temporarily unavailable");
  approvalFails = false;
  await card().getByRole("button", { name: "Approve and set up" }).click();
  await awaitText("Installing restricted public key");
  assert.equal(await card().getByText("Access verified", { exact: true }).count(), 0);
  rows[0] = { ...rows[0], state: "failed", blocks: [{ code: "ssh_failed", category: "connection", message: "SSH connection failed after key creation.", action: "Resume the same approved setup after restoring SSH." }], step: "" };
  await card().getByRole("button", { name: "Resume approved setup" }).waitFor({ timeout: 10000 });
  await card().getByRole("button", { name: "Resume approved setup" }).click();
  await awaitText("Verifying tunnel and role permissions");
  assert.equal(resumeCount, 1);
  rows[0] = { ...rows[0], state: "ready", status: "approved", step: "Access verified and catalog updated" };
  await awaitText("Access verified and catalog updated");
  await page.reload();
  await awaitText("Access verified and catalog updated");
  assert.equal(approveCount, 2);
  await page.screenshot({ path: `${output}/verified-desktop.png`, fullPage: true });

  // Several valid matches need a deliberate short selection, with readable environment labels.
  rows = [structuredClone(base)];
  candidates = [target, { ...target, id: "acme:staging", name: "billing-staging-db", environment: "staging" }];
  await page.reload();
  const picker = card().getByLabel("Choose the database and environment");
  await picker.waitFor();
  assert.equal(await picker.inputValue(), "");
  await picker.selectOption("acme:staging");
  assert.equal(await picker.inputValue(), "acme:staging");
  await card().getByRole("button", { name: "Reject request" }).click();
  await awaitText("Rejected");
  assert.equal(await card().getByRole("button", { name: "Approve and set up" }).count(), 0);

  // A late response for a closed request cannot replace a different request's selection.
  rows = [structuredClone(base), { ...base, id: 3, wanted: "other", project: "different-project" }];
  candidates = [target]; holdDiscovery = true;
  await page.reload();
  await page.waitForFunction(() => document.querySelector("#db-request-2")?.textContent.includes("Finding databases"));
  await page.locator("#db-request-3").getByRole("button", { name: "Review setup" }).click();
  const otherPicker = page.locator("#db-request-3").getByLabel("Matched database");
  await otherPicker.waitFor();
  assert.equal(await otherPicker.inputValue(), "other:db");
  releaseDiscovery(); holdDiscovery = false;
  await page.waitForResponse((r) => r.url().endsWith("/requests/2/discovery"));
  assert.equal(await otherPicker.inputValue(), "other:db");
  // Migration scope and explicit exceptions stay visible before separate SQL approval.
  writes = [{ id: 12, ts: Date.now(), session_id: base.session_id, db: "billing", sql: "ALTER TABLE invoices ADD COLUMN cash_reserve_amount numeric;", scope: "migration", status: "blocked", decided_at: null, result: null, error: null, exception: "Explicit authorization limited to this migration on billing", code: "migration_access_not_configured", requestId: 2, nextAction: "Prepare the migration role in Operations." }];
  await page.goto(`${origin}/#/prod-writes`);
  const writeCard = page.locator("#prod-write-12");
  await writeCard.getByText("Access setup needed", { exact: true }).waitFor();
  assert.equal(await writeCard.getByText("Recorded explicit exception:", { exact: false }).count(), 1);
  assert.equal(await writeCard.getByRole("button", { name: "Approve and execute SQL" }).count(), 0);
  assert.equal(await writeCard.getByRole("button", { name: "Reject SQL proposal" }).count(), 1);
  writes[0] = { ...writes[0], access: { state: "blocked", engine: "mariadb", blocks: [{ code: "scope_changed", message: "The access plan needs write permissions.", action: "Prepare the updated plan in Operations." }], nextAction: "Prepare the updated plan." } };
  await writeCard.getByText("The access plan needs write permissions.").waitFor({ timeout: 10000 });
  await page.screenshot({ path: `${output}/mariadb-block-details-desktop.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${output}/mariadb-block-details-mobile.png`, fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  writes[0] = { ...writes[0], access: { ...writes[0].access, state: "rejected" }, nextAction: "The request was rejected." };
  await writeCard.getByText("Database access was rejected.", { exact: true }).waitFor({ timeout: 10000 });
  writes[0] = { ...writes[0], status: "pending", code: null };
  await writeCard.getByRole("button", { name: "Review statement" }).waitFor({ timeout: 10000 });
  await writeCard.getByRole("button", { name: "Review statement" }).click();
  await writeCard.getByText("SQL has not run.", { exact: false }).waitFor();
  assert.equal(sqlExecutionCount, 0, "preview cannot execute SQL");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${output}/sql-approval-mobile.png`, fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  await writeCard.getByRole("button", { name: "Approve and execute SQL" }).click();
  await writeCard.getByText("Migration verified", { exact: true }).waitFor();
  assert.equal(sqlExecutionCount, 1);
  extraOperations = [{ id: 20, ts: Date.now(), session_id: base.session_id, op: "deploy", params: JSON.stringify({ application: "billing", commit: "a".repeat(40), afterWrite: "12", changes: JSON.stringify(["Deploy the reviewed commit to Billing production.", "Wait for successful SQL proposal #12."]) }), status: "approved", decided_at: Date.now(), result: null, error: null }];
  await page.goto(`${origin}/#/operations`);
  await page.getByText("#20 · Approved · waiting for SQL #12", { exact: true }).waitFor();
  await page.getByText("Deploy the reviewed commit to Billing production.", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Approve", exact: true }).count(), 0);
  await page.screenshot({ path: `${output}/deploy-wait-mobile.png`, fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: "passed", assertions: "target matching, trim, scoped DDL, immutable approval, duplicate clicks, all blocks, mobile overflow, persistent errors, verified result, resume, multiple candidates, rejection, stale discovery", prepareCount, approveCount, resumeCount, sqlExecutionCount, screenshots: output }));
} finally { await browser.close(); }
