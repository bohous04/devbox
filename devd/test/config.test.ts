import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, loadConfig, loadSecrets, resolveInstaboxSettings, saveConfig, saveGiteaTokens, materializeGiteaTokens } from "../src/config";

const dir = () => mkdtempSync(join(tmpdir(), "devd-cfg-"));

test("save→load roundtrip with sorted keys", () => {
  const p = join(dir(), "config.json");
  saveConfig(p, DEFAULT_CONFIG);
  const raw = readFileSync(p, "utf8");
  expect(raw.endsWith("\n")).toBe(true);
  expect(raw.indexOf('"folders"')).toBeLessThan(raw.indexOf('"settings"'));
  const cfg = loadConfig(p);
  expect(cfg.settings.portRangeStart).toBe(40100);
  // The default carries no concrete projects — those belong in the installation's config.json.
  expect(Object.keys(cfg.folders).sort()).toEqual(["apps", "websites"]);
});

test("invalid config throws readable ConfigError", () => {
  const p = join(dir(), "config.json");
  writeFileSync(p, JSON.stringify({ version: 1, folders: {} }));
  expect(() => loadConfig(p)).toThrow(/settings/);
});

test("missing secrets file yields empty object", () => {
  expect(loadSecrets(join(dir(), "secrets.json"))).toEqual({});
});

test("saveGiteaTokens keeps the other keys in secrets.json", () => {
  const dirPath = mkdtempSync(join(tmpdir(), "devd-secrets-"));
  const p = join(dirPath, "secrets.json");
  writeFileSync(p, JSON.stringify({ listenerToken: "L", pushover: { token: "t", user: "u" } }));
  saveGiteaTokens(p, { Portal: "secret" });
  const s = loadSecrets(p);
  expect(s.giteaTokens).toEqual({ Portal: "secret" });
  expect(s.listenerToken).toBe("L");
  expect(s.pushover).toEqual({ token: "t", user: "u" });
});

test("saveGiteaTokens works without an existing file too", () => {
  const dirPath = mkdtempSync(join(tmpdir(), "devd-secrets-"));
  const p = join(dirPath, "secrets.json");
  saveGiteaTokens(p, { a: "1" });
  expect(loadSecrets(p).giteaTokens).toEqual({ a: "1" });
  expect(statSync(p).mode & 0o777).toBe(0o600);
});

test("saveGiteaTokens tightens the permissions of an existing file to 0600", () => {
  const dirPath = mkdtempSync(join(tmpdir(), "devd-secrets-"));
  const p = join(dirPath, "secrets.json");
  writeFileSync(p, JSON.stringify({ listenerToken: "L" }), { mode: 0o644 });
  saveGiteaTokens(p, { Portal: "secret" });
  expect(statSync(p).mode & 0o777).toBe(0o600);
  expect(loadSecrets(p).listenerToken).toBe("L");
});

test("materializeGiteaTokens keys the token by the instance HOST (not name) — that is what git-credential-devbox reads", () => {
  const dirPath = mkdtempSync(join(tmpdir(), "devd-secrets-"));
  const p = join(dirPath, "gitea-tokens.json");
  // git sends host:port to the credential helper (verified); the instance name ("Portal") means nothing to it.
  materializeGiteaTokens(p, { Portal: "secret" }, [{ name: "Portal", url: "http://198.51.100.7:3000/" }]);
  expect(JSON.parse(readFileSync(p, "utf8"))).toEqual({ "198.51.100.7:3000": "secret" });
  // root (chown to 1000 succeeds) → 0600; non-root test → fallback 0644. Never more than 0644.
  expect([0o600, 0o644]).toContain(statSync(p).mode & 0o777);
});

test("materializeGiteaTokens skips an instance without a token and a token without an instance", () => {
  const dirPath = mkdtempSync(join(tmpdir(), "devd-secrets-"));
  const p = join(dirPath, "gitea-tokens.json");
  materializeGiteaTokens(p, { Portal: "secret", Orphan: "x" }, [
    { name: "Portal", url: "http://198.51.100.7:3000/" },
    { name: "Empty", url: "http://git.example.cz/" }, // no token → skip
  ]);
  expect(JSON.parse(readFileSync(p, "utf8"))).toEqual({ "198.51.100.7:3000": "secret" }); // Orphan has no instance → drop
});

test("materializeGiteaTokens overwrites the content and permissions of an existing file (not world-writable)", () => {
  const dirPath = mkdtempSync(join(tmpdir(), "devd-secrets-"));
  const p = join(dirPath, "gitea-tokens.json");
  writeFileSync(p, "{}", { mode: 0o666 }); // deliberately broad permissions → must tighten them
  materializeGiteaTokens(p, { Portal: "secret" }, [{ name: "Portal", url: "http://198.51.100.7:3000/" }]);
  expect([0o600, 0o644]).toContain(statSync(p).mode & 0o777); // 0600 as root, otherwise 0644 fallback
  expect(JSON.parse(readFileSync(p, "utf8"))).toEqual({ "198.51.100.7:3000": "secret" });
});

test("resolveInstaboxSettings: without devdUrl → null, otherwise defaults", () => {
  expect(resolveInstaboxSettings(undefined)).toBeNull();
  expect(resolveInstaboxSettings({})).toBeNull();
  expect(resolveInstaboxSettings({ devdUrl: "http://100.1.2.3:4300" })).toEqual({
    devdUrl: "http://100.1.2.3:4300", vmPort: 4301, suggestRamPct: 80, suggestLoadPerCore: 1, desktopWidth: 1440, desktopHeight: 900,
  });
  expect(resolveInstaboxSettings({ devdUrl: "http://x:4300", suggestRamPct: 70 })!.suggestRamPct).toBe(70);
});
