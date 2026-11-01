import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readKeyFile, writeKeyFile } from "../src/config";

function keyFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "cliproxy-"));
  const path = join(dir, "api-key");
  writeFileSync(path, content);
  return path;
}

test("the key is read from the file and the trailing newline is trimmed", () => {
  expect(readKeyFile(keyFile("abc123\n"))).toBe("abc123");
  expect(readKeyFile(keyFile("abc123"))).toBe("abc123");
});

// A missing file is a NORMAL state (proxy not installed), not an error — devd must
// start without it. Only agent-launch in the container complains loudly, since it alone knows
// that the session wanted a proxy profile.
test("a missing file returns null, not an exception", () => {
  expect(readKeyFile(join(tmpdir(), "cliproxy-missing", "api-key"))).toBeNull();
});

// An empty file is worse than a missing one: it looks configured, but an empty key would
// reach the container and cc would only fail on a 401. It must behave like a missing one.
test("empty or whitespace content is treated as a missing key", () => {
  expect(readKeyFile(keyFile(""))).toBeNull();
  expect(readKeyFile(keyFile("   \n"))).toBeNull();
});

// The key is entered from the dashboard, so devd writes it — not a human over SSH. The directory
// may not exist yet at that point (fresh deployment where nobody has connected OpenRouter).
test("writing also creates the missing directory and the key is then readable", () => {
  const path = join(mkdtempSync(join(tmpdir(), "keyfile-")), "openrouter", "api-key");
  writeKeyFile(path, "sk-or-v1-abc");
  expect(readKeyFile(path)).toBe("sk-or-v1-abc");
});

// 0600 is not cosmetic: foreign processes under other users run in the containers and in devd,
// and this file is a paid credential.
test("only the owner may read the key file", () => {
  const path = join(mkdtempSync(join(tmpdir(), "keyfile-")), "api-key");
  writeKeyFile(path, "sk-or-v1-abc");
  expect(statSync(path).mode & 0o777).toBe(0o600);
});

// Key rotation is routine (compromise, new account). Leftovers of the old key after
// the new one would give a broken credential that looks configured.
test("rotation overwrites the key, does not append", () => {
  const path = join(mkdtempSync(join(tmpdir(), "keyfile-")), "api-key");
  writeKeyFile(path, "sk-or-v1-old");
  writeKeyFile(path, "sk-or-v1-new");
  expect(readKeyFile(path)).toBe("sk-or-v1-new");
});

// The user will almost certainly paste the key into the dashboard field with a space or newline.
test("writing trims whitespace so a key with a newline is not sent in the header", () => {
  const path = join(mkdtempSync(join(tmpdir(), "keyfile-")), "api-key");
  writeKeyFile(path, "  sk-or-v1-abc\n");
  expect(readKeyFile(path)).toBe("sk-or-v1-abc");
});

// An empty write = "disconnect OpenRouter". Leaving an empty file behind would mean a state
// that readKeyFile reads as missing anyway — so let it actually be missing.
test("an empty key deletes the file instead of leaving an empty one", () => {
  const path = join(mkdtempSync(join(tmpdir(), "keyfile-")), "api-key");
  writeKeyFile(path, "sk-or-v1-abc");
  writeKeyFile(path, "   ");
  expect(existsSync(path)).toBe(false);
  expect(readKeyFile(path)).toBeNull();
});
