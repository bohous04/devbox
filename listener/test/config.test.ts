import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ListenerConfigError, loadListenerConfig } from "../src/config";

const dir = () => mkdtempSync(join(tmpdir(), "lst-"));

test("missing token fails closed", () => {
  expect(() => loadListenerConfig({}, join(dir(), "nope.json"))).toThrow(ListenerConfigError);
});

test("file config with env override", () => {
  const p = join(dir(), "config.json");
  writeFileSync(p, JSON.stringify({ token: "t1", host: "100.1.2.3", mappings: [{ from: "/srv/dev", to: "/Volumes/dev" }] }));
  const cfg = loadListenerConfig({}, p);
  expect(cfg).toMatchObject({ token: "t1", host: "100.1.2.3", port: 7777 });
  expect(loadListenerConfig({ DEVBOX_LISTENER_TOKEN: "t2", DEVBOX_LISTENER_PORT: "7800" }, p))
    .toMatchObject({ token: "t2", port: 7800 });
});

test("invalid port fails closed", () => {
  const missingPath = join(dir(), "nope.json");
  expect(() => loadListenerConfig({ DEVBOX_LISTENER_TOKEN: "t", DEVBOX_LISTENER_PORT: "abc" }, missingPath))
    .toThrow(ListenerConfigError);
});

test("explicit empty mappings array is respected, not treated as unset", () => {
  const p = join(dir(), "config.json");
  writeFileSync(p, JSON.stringify({ token: "t1", mappings: [] }));
  const cfg = loadListenerConfig({}, p);
  expect(cfg.mappings).toEqual([]);
});

test("dashboardUrl is read from file and env, default undefined", () => {
  const dir = mkdtempSync(join(tmpdir(), "lst-cfg-"));
  const p = join(dir, "config.json");
  writeFileSync(p, JSON.stringify({ token: "t", dashboardUrl: "https://dev.example.com" }));
  expect(loadListenerConfig({}, p).dashboardUrl).toBe("https://dev.example.com");
  expect(loadListenerConfig({ DEVBOX_DASHBOARD_URL: "http://x:4300" }, p).dashboardUrl).toBe("http://x:4300");
  writeFileSync(p, JSON.stringify({ token: "t" }));
  expect(loadListenerConfig({}, p).dashboardUrl).toBeUndefined();
});
