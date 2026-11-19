/** The first agent bridge that knows ACP harnesses: an older bridge's parseTarget refuses them with a ProtocolError,
 *  which drops devd's whole link. devd refuses such a switch (409 bridge-too-old); the dashboard disables it. */
export const ACP_MIN_BRIDGE_VERSION = "1.2.0";

/** `version` (the bridge's `x.y.z`) is `min` or newer. A version that is not `x.y.z` counts as older. */
export function versionAtLeast(version: string, min: string): boolean {
  const parse = (v: string) => (/^\d+\.\d+\.\d+$/.test(v) ? v.split(".").map(Number) : null);
  const a = parse(version);
  const b = parse(min);
  if (b === null) throw new Error(`not a version: ${min}`);
  if (a === null) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return true;
}
