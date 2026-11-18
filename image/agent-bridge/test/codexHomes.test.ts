import { afterEach, beforeEach, expect, test } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareShadowHome, SHARED_HOME, shadowHome } from "../src/codexHomes.ts";

let dir: string;
let opts: { sharedHome: string; shadowRoot: string; defaultAuth: string };
const ID = "11111111-2222-3333-4444-555555555555";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codex-homes-"));
  opts = { sharedHome: join(dir, "shared"), shadowRoot: join(dir, "shadow"), defaultAuth: join(dir, "default-auth.json") };
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

test("shadow home links shared dirs and the account auth in place", () => {
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

test("re-running is idempotent", () => {
  account(ID);
  const a = prepareShadowHome(ID, join(dir, "accounts"), opts);
  const b = prepareShadowHome(ID, join(dir, "accounts"), opts);
  expect(b).toBe(a);
  expect(readlinkSync(join(b, "auth.json"))).toBe(join(dir, "accounts", ID, "auth.json"));
});

test("auth.json is a symlink, never a regular file", () => {
  account(ID);
  const home = prepareShadowHome(ID, join(dir, "accounts"), opts);
  expect(lstatSync(join(home, "auth.json")).isSymbolicLink()).toBe(true);
});

test("a regular file where a link belongs is an error, not overwritten", () => {
  account(ID);
  mkdirSync(join(opts.shadowRoot, ID), { recursive: true });
  writeFileSync(join(opts.shadowRoot, ID, "auth.json"), "copied");
  expect(() => prepareShadowHome(ID, join(dir, "accounts"), opts)).toThrow("auth.json");
});

test("default account links the image's default auth", () => {
  writeFileSync(opts.defaultAuth, '{"t":2}');
  const home = prepareShadowHome("default", join(dir, "accounts"), opts);
  expect(readlinkSync(join(home, "auth.json"))).toBe(opts.defaultAuth);
});

test("rejects an id that is not default or a uuid", () => {
  expect(() => prepareShadowHome("../x", join(dir, "accounts"), opts)).toThrow("invalid");
});
