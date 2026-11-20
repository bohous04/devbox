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

/** The first agent bridge that takes a `startTurn` origin. An older bridge ignores the field and runs a critic
 *  follow-up as the user's turn, which would restart the critic's rounds: devd runs no critic on such a bridge. */
export const CRITIC_MIN_BRIDGE_VERSION = "1.3.0";

/** The first agent bridge that takes `startTurn` attachments (images). An older bridge refuses a turn that has them:
 *  devd answers 409 bridge-too-old instead of sending. */
export const IMAGES_MIN_BRIDGE_VERSION = "1.4.0";

/** The first agent bridge that takes devd's periodic `ack` (S6-R21). An older bridge refuses the unknown frame and
 *  closes the link: devd sends acks only to a bridge that is new enough. */
export const ACK_MIN_BRIDGE_VERSION = "1.5.0";

/** The first agent bridge that reports and takes a reasoning effort (`effort.state`, `setEffort`). An older bridge
 *  refuses the unknown command: devd answers 409 bridge-too-old and the dashboard disables the choice. */
export const EFFORT_MIN_BRIDGE_VERSION = "1.7.0";
