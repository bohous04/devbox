import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** The container env that carries the per-container secret devd stored for this session (1.6.0). */
export const BRIDGE_SECRET_ENV = "DEVD_BRIDGE_SECRET";
const SECRET = /^[0-9a-f]{64}$/;

/** A new container's secret (devd). */
export function newBridgeSecret(): string {
  return randomBytes(32).toString("hex");
}

export function isBridgeSecret(v: string): boolean {
  return SECRET.test(v);
}

/** What a bound bridge answers to devd's hello nonce: HMAC-SHA256 under the session's secret over the nonce and the
 *  session id, hex. devd checks it before it applies anything the bridge sends, so a socket that leads to another
 *  session's bridge (a proxy through a shared volume, a swapped socket) is refused. */
export function bridgeProof(secretHex: string, nonce: string, session: string): string {
  return createHmac("sha256", Buffer.from(secretHex, "hex")).update(`${nonce}\n${session}`).digest("hex");
}

/** Constant-time comparison of two hex proofs. */
export function proofMatches(expected: string, got: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(got, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
