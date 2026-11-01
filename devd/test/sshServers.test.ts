import { expect, test } from "bun:test";
import { validateConfig, DEFAULT_CONFIG } from "../src/config";
import { normalizeTarget, resolveSshTarget, sshServerIssues, type SshServer } from "../src/sshServers";

const shop: SshServer = { name: "shop-root", key: "K", user: "root", host: "192.0.2.11", port: 22 };

// --- sshServerIssues ---

test("sshServerIssues: an empty/missing array is valid", () => {
  expect(sshServerIssues(undefined)).toEqual([]);
  expect(sshServerIssues([])).toEqual([]);
});

test("sshServerIssues: a valid server returns no issues", () => {
  expect(sshServerIssues([shop])).toEqual([]);
});

test("sshServerIssues: duplicate name", () => {
  const issues = sshServerIssues([shop, { ...shop, host: "1.2.3.4" }]);
  expect(issues.length).toBeGreaterThan(0);
  expect(issues[0]).toMatch(/name/i);
});

test("sshServerIssues: port 0 is invalid", () => {
  const issues = sshServerIssues([{ ...shop, port: 0 }]);
  expect(issues.length).toBeGreaterThan(0);
  expect(issues[0]).toMatch(/port/i);
});

test("sshServerIssues: port above 65535 is invalid", () => {
  expect(sshServerIssues([{ ...shop, port: 65536 }]).length).toBeGreaterThan(0);
});

test("sshServerIssues: space in host", () => {
  const issues = sshServerIssues([{ ...shop, host: "1.2.3.4 " }]);
  expect(issues.length).toBeGreaterThan(0);
  expect(issues[0]).toMatch(/host/i);
});

test("sshServerIssues: invalid name format (uppercase, empty)", () => {
  expect(sshServerIssues([{ ...shop, name: "Shop-Root" }]).length).toBeGreaterThan(0);
  expect(sshServerIssues([{ ...shop, name: "" }]).length).toBeGreaterThan(0);
});

test("sshServerIssues: empty key/user", () => {
  expect(sshServerIssues([{ ...shop, key: "" }]).length).toBeGreaterThan(0);
  expect(sshServerIssues([{ ...shop, user: "" }]).length).toBeGreaterThan(0);
});

// --- normalizeTarget ---

test("normalizeTarget: keeps user case, lowercases host, adds the default port", () => {
  expect(normalizeTarget("Root@1.2.3.4")).toBe("Root@1.2.3.4:22");
});

test("normalizeTarget: an explicit port stays", () => {
  expect(normalizeTarget("main@h:2222")).toBe("main@h:2222");
});

test("normalizeTarget: host is lowercased", () => {
  expect(normalizeTarget("root@HOST.example.com")).toBe("root@host.example.com:22");
});

test("normalizeTarget: ssh option without user@ → null", () => {
  expect(normalizeTarget("-o")).toBeNull();
  expect(normalizeTarget("-p")).toBeNull();
  expect(normalizeTarget("")).toBeNull();
});

test("normalizeTarget: IPv6 with brackets round-trips", () => {
  expect(normalizeTarget("user@[::1]:2222")).toBe("user@[::1]:2222");
});

test("normalizeTarget: bare IPv6 without brackets gets the default port and brackets", () => {
  expect(normalizeTarget("user@::1")).toBe("user@[::1]:22");
});

// --- resolveSshTarget ---

test("resolveSshTarget: nothing given → all null", () => {
  expect(resolveSshTarget([shop], "K", {})).toEqual({ ok: true, server: null, target: null });
});

test("resolveSshTarget: alias of an existing server of the same key", () => {
  expect(resolveSshTarget([shop], "K", { server: "shop-root" })).toEqual({
    ok: true,
    server: "shop-root",
    target: "root@192.0.2.11:22",
  });
});

test("resolveSshTarget: alias of another key → error", () => {
  const result = resolveSshTarget([shop], "OTHER", { server: "shop-root" });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toBe("server shop-root does not belong to key OTHER");
});

test("resolveSshTarget: non-existent alias → error", () => {
  const result = resolveSshTarget([shop], "K", { server: "unknown" });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toBe("server unknown does not belong to key K");
});

test("resolveSshTarget: a free target matching a server of the same key fills in the server", () => {
  expect(resolveSshTarget([shop], "K", { target: "root@192.0.2.11" })).toEqual({
    ok: true,
    server: "shop-root",
    target: "root@192.0.2.11:22",
  });
});

test("resolveSshTarget: a free target on another port does not find a server", () => {
  expect(resolveSshTarget([shop], "K", { target: "root@192.0.2.11:2222" })).toEqual({
    ok: true,
    server: null,
    target: "root@192.0.2.11:2222",
  });
});

test("resolveSshTarget: a free target without user@ is stored raw, server null", () => {
  expect(resolveSshTarget([shop], "K", { target: "-p" })).toEqual({
    ok: true,
    server: null,
    target: "-p",
  });
});

// --- validateConfig integration ---

test("validateConfig: a config without sshServers stays valid", () => {
  expect(() => validateConfig(DEFAULT_CONFIG)).not.toThrow();
});

test("validateConfig: invalid sshServers throws ConfigError with the first issue", () => {
  expect(() => validateConfig({ ...DEFAULT_CONFIG, sshServers: [shop, shop] })).toThrow(/name/i);
});

test("validateConfig: valid sshServers passes", () => {
  expect(() => validateConfig({ ...DEFAULT_CONFIG, sshServers: [shop] })).not.toThrow();
});

test("sshServerIssues: key is a 1Password title and may contain spaces, but not be empty", () => {
  const base = { name: "shop", user: "main", host: "192.0.2.11", port: 2222 };
  expect(sshServerIssues([{ ...base, key: "SSH Key - Client shop" }])).toEqual([]);
  expect(sshServerIssues([{ ...base, key: "   " }])).toHaveLength(1);
  expect(sshServerIssues([{ ...base, key: "SSH Key - Client shop", user: "ma in" }])).toHaveLength(1);
});
