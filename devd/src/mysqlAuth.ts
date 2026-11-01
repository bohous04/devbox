import { createHash } from "node:crypto";

const sha1 = (data: Uint8Array | string) => createHash("sha1").update(data).digest();
/** MariaDB mysql_native_password challenge response; used only over the local
 * bridge and an encrypted SSH tunnel. Real passwords never reach a session. */
export function mysqlResponse(password: string, salt: Buffer): Buffer {
  const first = sha1(password), mask = sha1(Buffer.concat([salt, sha1(first)]));
  return Buffer.from(first.map((byte, i) => byte ^ mask[i]!));
}
export function mysqlPasswordHash(password: string): string {
  return "*" + sha1(sha1(password)).toString("hex").toUpperCase();
}
