import { expect, test } from "bun:test";
import type { ApiClient } from "../src/api";
import { askFresh, closeParentTab } from "../src/main";
import type { Target } from "../src/resolve";

const target: Target = { folder: "acme", project: "shop", repo: "web", cloned: true };
const deps = (api: unknown) => ({ cfg: { devdUrl: "u" }, api: api as ApiClient });

// A notification click and automation both run without a TTY: the "attach / create another"
// question must not appear there (a clack select against /dev/null would never resolve) and the
// behavior must stay as it is today — attach to what is running.
test("askFresh: without a TTY it does not ask, does not touch the API and creates no extra session", async () => {
  const api = { sessions: () => { throw new Error("/api/sessions must not be called without a TTY"); } };
  expect(await askFresh(deps(api), target, false)).toBe(false);
});

// When nothing is running for THAT repo there is nothing to ask — another repo in the same
// project does not count (otherwise `dev` would ask even where there is only one choice).
test("askFresh: does not ask without a running session for that repo", async () => {
  const api = { sessions: async () => [
    { project: "shop", repo: "web", status: "stopped" },
    { project: "shop", repo: "api", status: "running" },
  ] };
  expect(await askFresh(deps(api), target, true)).toBe(false);
});

// Fix: the SIGHUP that closes the Warp tab (after a successful end/stop) must not escape as
// "Error" + exit 1 — the end/stop already happened, the tab just does not close by itself.
// process.kill throws ESRCH/EPERM e.g. for a dead/unreachable parent process; closeParentTab
// must swallow it.
test("closeParentTab: an error from process.kill (ESRCH/EPERM) is swallowed, not propagated", () => {
  const original = process.kill;
  process.kill = () => { throw new Error("ESRCH"); };
  try {
    expect(() => closeParentTab()).not.toThrow();
  } finally {
    process.kill = original;
  }
});
