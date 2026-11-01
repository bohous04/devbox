import { expect, test } from "bun:test";
import { createApp } from "../src/api";
import { fakeDeps, fakeVault } from "./helpers/apiHarness";

const json = (body: unknown) => ({
  method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" },
});

test("GET /api/vault reports locked", async () => {
  const app = createApp(fakeDeps({ vault: fakeVault({ locked: true }) }));
  const r = await app.request("/api/vault");
  expect(await r.json()).toEqual({ locked: true });
});

test("unlock with the right passphrase unlocks", async () => {
  const app = createApp(fakeDeps({ vault: fakeVault({ locked: true, passphrase: "f" }) }));
  const r = await app.request("/api/vault/unlock", json({ passphrase: "f" }));
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ locked: false });
});

test("unlock with a wrong passphrase returns 401 and stays locked", async () => {
  const deps = fakeDeps({ vault: fakeVault({ locked: true, passphrase: "f" }) });
  const app = createApp(deps);
  const r = await app.request("/api/vault/unlock", json({ passphrase: "wrong" }));
  expect(r.status).toBe(401);
  expect(deps.vault!.isLocked()).toBe(true);
});

test("an endpoint touching credentials returns 423 when locked", async () => {
  const app = createApp(fakeDeps({ vault: fakeVault({ locked: true }), opToken: "tok" }));
  const r = await app.request("/api/op/ssh-keys");
  expect(r.status).toBe(423);
  expect(((await r.json()) as { error: string }).error).toContain("vault");
});

// Note: `opToken` is DELIBERATELY not set in the following tests. With it the route would
// launch the `op` binary, which waits for authentication and the test hangs. Without a token the route returns 503,
// which proves just as well that the vault gate did not intercept it earlier.
test("after unlocking, the vault gate no longer intervenes", async () => {
  const app = createApp(fakeDeps({ vault: fakeVault({ locked: false }) }));
  expect((await app.request("/api/op/ssh-keys")).status).toBe(503);
});

test("without a configured vault it behaves as before", async () => {
  const app = createApp(fakeDeps());
  expect(await (await app.request("/api/vault")).json()).toEqual({ locked: false });
  expect((await app.request("/api/op/ssh-keys")).status).toBe(503);
});
