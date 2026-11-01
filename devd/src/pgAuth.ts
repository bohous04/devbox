import { createHash, createHmac, pbkdf2Sync } from "node:crypto";

// SCRAM-SHA-256 (RFC 7677) — the default authentication of modern Postgres. The proxy performs it
// ITSELF with the real credentials, so the client in the container needs no password.
// Verified against the RFC test vectors, not against a running database.

const hmac = (key: Buffer, data: string) => createHmac("sha256", key).update(data).digest();
const sha256 = (b: Buffer) => createHash("sha256").update(b).digest();

/** `n=<user>,r=<nonce>`. Postgres sends the user empty — the name is already in the startup
 *  packet — but the RFC test vectors have it filled in, so it is a parameter. */
export function scramFirstBare(nonce: string, username = ""): string {
  return `n=${username},r=${nonce}`;
}

export interface ScramResult { clientFinal: string; serverSignature: string }

export function scramFinal(
  password: string, clientNonce: string, serverFirst: string, username = "",
): ScramResult {
  const attrs = new Map(serverFirst.split(",").map((p) => [p.slice(0, 1), p.slice(2)]));
  const combinedNonce = attrs.get("r") ?? "";
  const salt = Buffer.from(attrs.get("s") ?? "", "base64");
  const iterations = Number(attrs.get("i") ?? 0);
  // The server MUST repeat our nonce as a prefix. If it does not, we are talking to someone else.
  if (!combinedNonce.startsWith(clientNonce)) throw new Error("server returned a foreign nonce");

  const saltedPassword = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  const clientKey = hmac(saltedPassword, "Client Key");
  const storedKey = sha256(clientKey);

  // c=biws is base64 of "n,," — an empty GS2 header.
  const finalWithoutProof = `c=biws,r=${combinedNonce}`;
  const authMessage = `${scramFirstBare(clientNonce, username)},${serverFirst},${finalWithoutProof}`;

  const clientSignature = hmac(storedKey, authMessage);
  const proof = Buffer.alloc(clientKey.length);
  for (let i = 0; i < clientKey.length; i++) proof[i] = clientKey[i]! ^ clientSignature[i]!;

  const serverKey = hmac(saltedPassword, "Server Key");
  return {
    clientFinal: `${finalWithoutProof},p=${proof.toString("base64")}`,
    serverSignature: hmac(serverKey, authMessage).toString("base64"),
  };
}
