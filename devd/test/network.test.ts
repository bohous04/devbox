import { expect, test } from "bun:test";
import { isAddressInCidr, isApprovalAllowed, isWideCidr, parseCidr } from "../src/network";

/* ==================== parseCidr ==================== */

test("parseCidr parses an IPv4 CIDR", () => {
  expect(parseCidr("100.64.0.0/10")).toEqual({ family: 4, base: 0x64400000n, prefix: 10 });
});

test("parseCidr parses an IPv6 CIDR", () => {
  expect(parseCidr("::1/128")).toEqual({ family: 6, base: 1n, prefix: 128 });
});

test("parseCidr without a slash takes the address as /32 or /128", () => {
  expect(parseCidr("127.0.0.1")).toEqual({ family: 4, base: 0x7f000001n, prefix: 32 });
  expect(parseCidr("::1")).toEqual({ family: 6, base: 1n, prefix: 128 });
});

test("parseCidr: prefix beyond the family maximum is null", () => {
  expect(parseCidr("10.0.0.0/33")).toBeNull();
  expect(parseCidr("::/129")).toBeNull();
});

test("parseCidr: malformed input is null, not a throw", () => {
  expect(parseCidr("")).toBeNull();
  expect(parseCidr("not-a-cidr")).toBeNull();
  expect(parseCidr("10.0.0.0/abc")).toBeNull();
  expect(parseCidr("999.1.1.1/8")).toBeNull();
});

/* ==================== isAddressInCidr (boundaries) ==================== */

test("Tailscale CGNAT boundaries: 100.63.255.255 outside, 100.64.0.0 and 100.127.255.255 inside, 100.128.0.0 outside", () => {
  expect(isAddressInCidr("100.63.255.255", "100.64.0.0/10")).toBe(false);
  expect(isAddressInCidr("100.64.0.0", "100.64.0.0/10")).toBe(true);
  expect(isAddressInCidr("100.127.255.255", "100.64.0.0/10")).toBe(true);
  expect(isAddressInCidr("100.128.0.0", "100.64.0.0/10")).toBe(false);
});

test("isAddressInCidr: mixed families (IPv4 address vs. IPv6 CIDR) is false", () => {
  expect(isAddressInCidr("127.0.0.1", "::1/128")).toBe(false);
});

/* ==================== isApprovalAllowed — main address table ==================== */

const cases: Array<[string, string | undefined, boolean]> = [
  ["loopback IPv4", "127.0.0.1", true],
  ["loopback IPv6", "::1", true],
  ["loopback IPv4-mapped IPv6", "::ffff:127.0.0.1", true],
  ["tailnet address", "100.101.102.103", true],
  ["docker-bridge address", "172.17.0.2", false],
  ["public address", "8.8.8.8", false],
  ["malformed string", "totally-not-an-ip", false],
  ["empty string", "", false],
  ["undefined (address could not be determined)", undefined, false],
];

for (const [label, addr, expected] of cases) {
  test(`isApprovalAllowed: ${label} → ${expected}`, () => {
    expect(isApprovalAllowed(addr)).toBe(expected);
  });
}

test("isApprovalAllowed: DEVD_APPROVAL_ALLOW extends the allowlist with an extra address/CIDR", () => {
  expect(isApprovalAllowed("203.0.113.9")).toBe(false);
  expect(isApprovalAllowed("203.0.113.9", ["203.0.113.9"])).toBe(true);
  expect(isApprovalAllowed("203.0.113.20", ["203.0.113.0/24"])).toBe(true);
});

test("isApprovalAllowed: a malformed CIDR in the extra list is silently ignored (allows nothing, does not crash)", () => {
  expect(isApprovalAllowed("8.8.8.8", ["not-a-cidr", ""])).toBe(false);
  expect(isApprovalAllowed("127.0.0.1", ["not-a-cidr"])).toBe(true); // default loopback still applies
});

test("isApprovalAllowed: Tailscale IPv6 range (fd7a:115c:a1e0::/48) is allowed, the neighbouring /48 is not", () => {
  expect(isApprovalAllowed("fd7a:115c:a1e0::1")).toBe(true);
  expect(isApprovalAllowed("fd7a:115c:a1e0:ffff:ffff:ffff:ffff:ffff")).toBe(true);
  expect(isApprovalAllowed("fd7a:115c:a1e1::1")).toBe(false); // right past the /48 boundary
});

/* ==================== Adversarial shapes — must stay rejected ====================
 * Review (fix round 1): these shapes are rejected today "by accident" (the strict
 * parser never recognises them as a valid address), not because the code explicitly
 * refuses them. The test is here so a future parser refactor does not loosen the boundary unintentionally. */

const rejectedShapes: Array<[string, string]> = [
  ["octal-looking octet", "0177.0.0.1"],
  ["leading zero in an octet", "010.0.0.1"],
  ["decimal integer (inet_aton form)", "2130706433"],
  ["shortened IPv4 form", "127.1"],
  ["hex octet", "0x7f.0.0.1"],
  ["trailing dot", "127.0.0.1."],
  ["IPv4 with an appended port", "127.0.0.1:4300"],
  ["IPv6 in square brackets with a port", "[::1]:4300"],
  ["deprecated IPv4-compatible IPv6 (not the mapped ::ffff: form)", "::127.0.0.1"],
  ["NAT64 well-known prefix with an embedded IPv4 loopback address", "64:ff9b::127.0.0.1"],
  ["IPv4-mapped IPv6 carrying a docker-bridge address", "::ffff:172.17.0.2"],
];

for (const [label, addr] of rejectedShapes) {
  test(`isApprovalAllowed rejects — ${label} ("${addr}")`, () => {
    expect(isApprovalAllowed(addr)).toBe(false);
  });
}

/* ==================== isWideCidr ==================== */

test("isWideCidr: IPv4 wider than /8 is 'wide', /8 and narrower is not", () => {
  expect(isWideCidr("0.0.0.0/0")).toBe(true);
  expect(isWideCidr("10.0.0.0/7")).toBe(true);
  expect(isWideCidr("10.0.0.0/8")).toBe(false);
  expect(isWideCidr("203.0.113.9")).toBe(false); // no slash = /32, definitely not wide
});

test("isWideCidr: IPv6 wider than /32 is 'wide', /32 and narrower is not", () => {
  expect(isWideCidr("::/0")).toBe(true);
  expect(isWideCidr("fd7a::/31")).toBe(true);
  expect(isWideCidr("fd7a::/32")).toBe(false);
  expect(isWideCidr("::1")).toBe(false); // /128
});

test("isWideCidr: invalid input is false, not a throw", () => {
  expect(isWideCidr("not-a-cidr")).toBe(false);
  expect(isWideCidr("")).toBe(false);
});
