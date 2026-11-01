import { expect, test } from "bun:test";
import { Hono } from "hono";
import { createApp } from "../src/api";
import { fakeDeps } from "./helpers/apiHarness";

// Regression: the proxy was registered after the dashboard catch-all, so /git/* got
// the HTML SPA instead of git. Hono matches in registration order.
test("/git/* reaches the proxy, not the dashboard SPA", async () => {
  const gitProxy = new Hono();
  gitProxy.all("/git/:instance/*", (c) => c.text("PROXY", 418));
  const r = await createApp(fakeDeps({ gitProxy })).request("/git/infra/repo.git/info/refs");
  expect(r.status).toBe(418);
  expect(await r.text()).toBe("PROXY");
});

test("without the proxy nothing changes", async () => {
  const r = await createApp(fakeDeps()).request("/git/infra/repo.git/info/refs");
  expect(r.status).not.toBe(418);
});
