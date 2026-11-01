// Source address allowlist for human decisions in SSH approvals (see api.ts,
// `approvalGate`). Pure functions with no dependency on Hono/Bun — testable with a table of
// addresses without a real server (see network.test.ts). The source address itself is
// determined elsewhere (index.ts, via `hono/bun`'s getConnInfo) and arrives here as a string.

type Family = 4 | 6;

interface Address { family: Family; value: bigint; }
interface Cidr { family: Family; base: bigint; prefix: number; }

/** Loopback (both families) + the Tailscale CGNAT range (IPv4), which the whole
 *  tailnet falls into (see docs/mac.md — network facts verified on a live host), + the IPv6
 *  tailnet range `fd7a:115c:a1e0::/48` (Tailscale ULA). Today's Mac/iOS configuration
 *  sends the tailnet address as a literal IPv4 (`100.x.x.x`), so the IPv6 branch
 *  never actually runs — it is here preventively: a MagicDNS/`*.ts.net` name also returns an AAAA
 *  record and iOS strongly prefers IPv6, so switching to a name instead of an IPv4 literal
 *  would end in an unexplained 403 without this.
 *
 *  The dashboard and iOS app may add more addresses via `DEVD_APPROVAL_ALLOW` (escape
 *  hatch for cloudflared, see isApprovalAllowed below) — that list does NOT BELONG here, so
 *  this default base can be tested on its own. */
export const DEFAULT_APPROVAL_CIDRS: readonly string[] = [
  "127.0.0.0/8", "::1/128", "100.64.0.0/10", "fd7a:115c:a1e0::/48",
];

function parseIpv4(addr: string): bigint | null {
  const parts = addr.split(".");
  if (parts.length !== 4) return null;
  let out = 0n;
  for (const p of parts) {
    // No leading-zero forms ("010") — different parsers interpret those as octal
    // and we do not want two readings of the same address.
    if (!/^(0|[1-9]\d{0,2})$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out = (out << 8n) | BigInt(n);
  }
  return out;
}

// Expands the abbreviated `::` form to 8 groups (fills zeros after/before it). `null` when
// the input does not have a valid number of groups or contains more than one `::`.
function expandIpv6Groups(addr: string): string[] | null {
  const halves = addr.split("::");
  if (halves.length > 2) return null;
  if (halves.length === 2) {
    const [h, t] = halves;
    const head = h === "" ? [] : h.split(":");
    const tail = t === "" ? [] : t.split(":");
    const missing = 8 - (head.length + tail.length);
    if (missing < 0) return null;
    return [...head, ...Array(missing).fill("0"), ...tail];
  }
  const groups = addr.split(":");
  return groups.length === 8 ? groups : null;
}

function parseIpv6(raw: string): bigint | null {
  let addr = raw;
  const zoneIdx = addr.indexOf("%");
  if (zoneIdx !== -1) addr = addr.slice(0, zoneIdx); // the zone (fe80::1%eth0) does not interest us

  if (addr.includes(".")) {
    // IPv4-mapped/embedded form (`::ffff:127.0.0.1`) — the last group is a dotted address.
    const lastColon = addr.lastIndexOf(":");
    if (lastColon === -1) return null;
    const v4 = parseIpv4(addr.slice(lastColon + 1));
    if (v4 === null) return null;
    const hex = v4.toString(16).padStart(8, "0");
    addr = `${addr.slice(0, lastColon + 1)}${hex.slice(0, 4)}:${hex.slice(4)}`;
  }

  const groups = expandIpv6Groups(addr);
  if (!groups) return null;
  let out = 0n;
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    out = (out << 16n) | BigInt(parseInt(g, 16));
  }
  return out;
}

const MAPPED_PREFIX = 0xffffn; // the upper 96 bits of `::ffff:0:0/96` have the value 0xffff

/** IPv4-mapped IPv6 (`::ffff:a.b.c.d`) is unwrapped to plain IPv4 — a live smoke test
 *  through a real `Bun.serve` showed that Bun reports loopback as "127.0.0.1"/"::1"
 *  without mapping, but the spec explicitly wants the mapped form covered (another runtime/proxy
 *  in front of devd could send it) and without unwrapping the IPv4 CIDRs (127.0.0.0/8,
 *  100.64.0.0/10) would never catch a mapped address. */
function normalizeAddress(raw: string): Address | null {
  const addr = raw.trim().replace(/^\[|\]$/g, "");
  if (!addr) return null;
  const v4 = parseIpv4(addr);
  if (v4 !== null) return { family: 4, value: v4 };
  const v6 = parseIpv6(addr);
  if (v6 === null) return null;
  if (v6 >> 32n === MAPPED_PREFIX) return { family: 4, value: v6 & 0xffffffffn };
  return { family: 6, value: v6 };
}

/** Parses a CIDR (`100.64.0.0/10`) or a single address (without a slash — taken
 *  as /32 or /128 respectively). `null` = invalid input; the caller (isAddressInCidr) should
 *  drop it silently, not crash — `DEVD_APPROVAL_ALLOW` is a manual env variable and
 *  a typo in it must not bring down devd. */
export function parseCidr(input: string): Cidr | null {
  const s = input.trim();
  if (!s) return null;
  const slash = s.indexOf("/");
  const addrPart = slash === -1 ? s : s.slice(0, slash);
  const norm = normalizeAddress(addrPart);
  if (!norm) return null;
  const maxBits = norm.family === 4 ? 32 : 128;
  if (slash === -1) return { family: norm.family, base: norm.value, prefix: maxBits };
  const prefixPart = s.slice(slash + 1);
  if (!/^\d{1,3}$/.test(prefixPart)) return null;
  const prefix = Number(prefixPart);
  if (prefix > maxBits) return null;
  return { family: norm.family, base: norm.value, prefix };
}

/** Is `addr` inside `cidr`? Invalid address, invalid CIDR or mixed families (IPv4
 *  address against an IPv6 CIDR) → false, never throw — so isApprovalAllowed can
 *  run through the whole list without a try/catch around each entry. */
export function isAddressInCidr(addr: string, cidr: string): boolean {
  const a = normalizeAddress(addr);
  const c = parseCidr(cidr);
  if (!a || !c || a.family !== c.family) return false;
  const bits = c.family === 4 ? 32 : 128;
  const shift = BigInt(bits - c.prefix);
  const mask = shift === 0n ? (1n << BigInt(bits)) - 1n : ((1n << BigInt(c.prefix)) - 1n) << shift;
  return (a.value & mask) === (c.base & mask);
}

// Tailnet addresses of InstaBox machines (C1 final review). The machine is in the tailnet (100.64.0.0/10)
// and docker inside it masquerades container traffic as the machine's IP — without this exception an agent
// in the VM would pass the allowlist and approve its own prod-db write, operation or SSH grant.
// The guarantee holds independently of Tailscale ACLs. Addresses of ended sessions are kept until a devd
// restart (the machine may live on for a while); they are forgotten only for machines that reconcile reports
// as lost (the IP may be assigned to another tailnet device).
const instaboxIps = new Set<string>();

/** Registers an InstaBox machine's tailnet IPv4 — from then on no approval gate lets it through. */
export function addInstaboxIp(ip: string): void {
  const a = normalizeAddress(ip);
  if (a) instaboxIps.add(`${a.family}:${a.value}`);
}
export function forgetInstaboxIp(ip: string): void {
  const a = normalizeAddress(ip);
  if (a) instaboxIps.delete(`${a.family}:${a.value}`);
}
/** Tests only (state is per process). */
export function clearInstaboxIps(): void { instaboxIps.clear(); }
export function isInstaboxAddress(addr: string | undefined | null): boolean {
  if (!addr) return false;
  const a = normalizeAddress(addr);
  return a !== null && instaboxIps.has(`${a.family}:${a.value}`);
}

/** Allowlist for the decision and cross-session SSH-approval routes (approve/deny,
 *  DELETE grants, GET lists — see the comment at `approvalGate` in api.ts). Loopback
 *  and tailnet are always in the allowlist; `extra` is the content of `DEVD_APPROVAL_ALLOW` (escape
 *  hatch for the dashboard's cloudflared tunnel, see docs/mac.md — its source
 *  address could not be verified on a live host in advance).
 *
 *  Empty/missing/unrecognizable address → false (fail-closed). The caller
 *  (`approvalGate`) answers false with 403 and writes to the log either this address or
 *  that it was determined as "unknown" — from the allowlist's point of view it is the same denial, but
 *  the log should say which case it was, so a configuration error (`DEVD_HOST`,
 *  missing `getConnInfo`) can be told apart from an outside attack. */
export function isApprovalAllowed(addr: string | undefined | null, extra: readonly string[] = []): boolean {
  if (!addr) return false;
  if (isInstaboxAddress(addr)) return false;
  const cidrs = [...DEFAULT_APPROVAL_CIDRS, ...extra];
  return cidrs.some((cidr) => isAddressInCidr(addr, cidr));
}

/** Threshold for `isWideCidr` below: a prefix SMALLER than this (= a wider address range) is
 *  "suspiciously large". `/8` for IPv4 is 16M addresses — more than a single tunnel/endpoint
 *  should ever cover. `/32` for IPv6 sounds strict (128-bit space), but it is
 *  deliberately at the same level as IPv4 `/8`: a typical allocation of a whole ISP, not
 *  of one machine — anything wider in `DEVD_APPROVAL_ALLOW` is almost certainly not
 *  what the operator meant when pasting a single address from the log. */
const WIDE_THRESHOLD: Record<Family, number> = { 4: 8, 6: 32 };

/** Is `cidr` wider than `WIDE_THRESHOLD` for its family? Invalid input → false —
 *  `isAddressInCidr`/`isApprovalAllowed` already drop it silently themselves; this function
 *  only judges the width of a valid range. It is not used for rejection — only for a loud
 *  warning at startup (see index.ts): an operator who means `DEVD_APPROVAL_ALLOW`
 *  seriously (e.g. `0.0.0.0/0` in an emergency) must still be able to set it. */
export function isWideCidr(cidr: string): boolean {
  const c = parseCidr(cidr);
  return c !== null && c.prefix < WIDE_THRESHOLD[c.family];
}
