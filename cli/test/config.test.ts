import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCliConfig } from "../src/config";

test("defaults when nothing configured", () => {
  expect(loadCliConfig({}, join(mkdtempSync(join(tmpdir(), "cli-")), "nope.json")))
    .toEqual({ devdUrl: "http://127.0.0.1:4300" });
});

test("config file overrides defaults, env overrides file", () => {
  const p = join(mkdtempSync(join(tmpdir(), "cli-")), "config.json");
  writeFileSync(p, JSON.stringify({ devdUrl: "http://vps:4300", sshHost: "vps" }));
  expect(loadCliConfig({}, p)).toEqual({ devdUrl: "http://vps:4300", sshHost: "vps" });
  expect(loadCliConfig({ DEV_DEVD_URL: "http://x:1", DEV_SSH_HOST: "y" }, p))
    .toEqual({ devdUrl: "http://x:1", sshHost: "y" });
});

test("empty-string env values fall through instead of being treated as set", () => {
  const missingPath = join(mkdtempSync(join(tmpdir(), "cli-")), "nope.json");
  expect(loadCliConfig({ DEV_SSH_HOST: "" }, missingPath).sshHost).toBeUndefined();
});

test("sshHostAlt: backup network path from file and env, empty env is ignored", () => {
  const p = join(mkdtempSync(join(tmpdir(), "cli-")), "config.json");
  writeFileSync(p, JSON.stringify({ devdUrl: "u", sshHost: "vps", sshHostAlt: "vps-ts" }));
  expect(loadCliConfig({}, p).sshHostAlt).toBe("vps-ts");
  expect(loadCliConfig({ DEV_SSH_HOST_ALT: "jina" }, p).sshHostAlt).toBe("jina");
  expect(loadCliConfig({ DEV_SSH_HOST_ALT: "" }, p).sshHostAlt).toBe("vps-ts");
  expect(loadCliConfig({}, join(mkdtempSync(join(tmpdir(), "cli-")), "nope.json")).sshHostAlt).toBeUndefined();
});
