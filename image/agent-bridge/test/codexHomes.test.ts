import { afterEach, beforeEach, expect, test } from "bun:test";
import { lstatSync, mkdirSync, readdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareShadowHome, SHARED_HOME, shadowHome } from "../src/codexHomes.ts";

// Seeding runs codex-account-seed.py, which needs Python >= 3.11 (tomllib).
const seedTest = test.skipIf(Bun.spawnSync(["python3", "-c", "import tomllib"]).exitCode !== 0);

let dir: string;
let opts: { sharedHome: string; shadowRoot: string; defaultAuth: string; defaultHome: string; seedScript: string };
const ID = "11111111-2222-3333-4444-555555555555";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codex-homes-"));
  opts = { sharedHome: join(dir, "shared"), shadowRoot: join(dir, "shadow"), defaultAuth: join(dir, "default-auth.json"),
    defaultHome: join(dir, "default-home"),
    seedScript: join(import.meta.dir, "..", "..", "codex-account-seed.py"),
  };
  mkdirSync(opts.defaultHome);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function account(id: string, auth = '{"t":1}') {
  mkdirSync(join(dir, "accounts", id), { recursive: true });
  writeFileSync(join(dir, "accounts", id, "auth.json"), auth);
}

test("shadowHome path", () => {
  expect(shadowHome(ID)).toBe(`/home/dev/.codex-v2/shadow/${ID}`);
  expect(SHARED_HOME).toBe("/home/dev/.codex-v2/shared");
});

seedTest("shadow home links shared dirs and the account auth in place", () => {
  account(ID);
  const home = prepareShadowHome(ID, join(dir, "accounts"), opts);
  expect(home).toBe(join(opts.shadowRoot, ID));
  for (const name of ["sessions", "sqlite", "archived_sessions", "history.jsonl", "config.toml"]) {
    expect(readlinkSync(join(home, name))).toBe(join(opts.sharedHome, name));
  }
  expect(readlinkSync(join(home, "auth.json"))).toBe(join(dir, "accounts", ID, "auth.json"));
});

test("missing auth.json throws naming the account", () => {
  mkdirSync(join(dir, "accounts", ID), { recursive: true });
  expect(() => prepareShadowHome(ID, join(dir, "accounts"), opts)).toThrow(ID);
  account(ID, "");
  expect(() => prepareShadowHome(ID, join(dir, "accounts"), opts)).toThrow(ID);
});

seedTest("re-running is idempotent", () => {
  account(ID);
  const a = prepareShadowHome(ID, join(dir, "accounts"), opts);
  const b = prepareShadowHome(ID, join(dir, "accounts"), opts);
  expect(b).toBe(a);
  expect(readlinkSync(join(b, "auth.json"))).toBe(join(dir, "accounts", ID, "auth.json"));
});

seedTest("auth.json is a symlink, never a regular file", () => {
  account(ID);
  const home = prepareShadowHome(ID, join(dir, "accounts"), opts);
  expect(lstatSync(join(home, "auth.json")).isSymbolicLink()).toBe(true);
});

seedTest("a regular file where a link belongs is an error, not overwritten", () => {
  account(ID);
  mkdirSync(join(opts.shadowRoot, ID), { recursive: true });
  writeFileSync(join(opts.shadowRoot, ID, "auth.json"), "copied");
  expect(() => prepareShadowHome(ID, join(dir, "accounts"), opts)).toThrow("auth.json");
});

seedTest("default account links the image's default auth", () => {
  writeFileSync(opts.defaultAuth, '{"t":2}');
  const home = prepareShadowHome("default", join(dir, "accounts"), opts);
  expect(readlinkSync(join(home, "auth.json"))).toBe(opts.defaultAuth);
});

test("rejects an id that is not default or a uuid", () => {
  expect(() => prepareShadowHome("../x", join(dir, "accounts"), opts)).toThrow("invalid");
});

seedTest("seeds the shared config.toml once from the default home", () => {
  account(ID);
  writeFileSync(join(opts.defaultHome, "config.toml"), 'model = "m1"\nsecret_unlisted = 1\n');
  prepareShadowHome(ID, join(dir, "accounts"), opts);
  const config = readFileSync(join(opts.sharedHome, "config.toml"), "utf8");
  expect(config).toContain('"model" = "m1"');
  expect(config).not.toContain("secret_unlisted");
  expect(config).toContain(`"sqlite_home" = ${JSON.stringify(join(opts.sharedHome, "sqlite"))}`);
  expect(config.match(/sqlite_home/g)).toHaveLength(1);
  // Nothing else from the seed step leaks into the shared home.
  expect(readdirSync(opts.sharedHome).filter((n) => n.startsWith("."))).toEqual([]);
});

seedTest("an existing non-empty shared config is left alone", () => {
  account(ID);
  mkdirSync(opts.sharedHome, { recursive: true });
  writeFileSync(join(opts.sharedHome, "config.toml"), "# mine\n");
  writeFileSync(join(opts.defaultHome, "config.toml"), 'model = "m1"\n');
  prepareShadowHome(ID, join(dir, "accounts"), opts);
  expect(readFileSync(join(opts.sharedHome, "config.toml"), "utf8")).toBe("# mine\n");
});

seedTest("a failing seed is an error, not an empty config", () => {
  account(ID);
  writeFileSync(join(opts.defaultHome, "config.toml"), "not = [valid");
  expect(() => prepareShadowHome(ID, join(dir, "accounts"), opts)).toThrow("seeding");
});
