import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openVault } from "../src/vaultCrypto";

const repoRoot = join(import.meta.dir, "../..");

async function migrate(args: string[], passphrase: string) {
  const p = Bun.spawn(["bun", "tools/vault-migrate.ts", ...args], {
    cwd: repoRoot, stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  p.stdin.write(passphrase + "\n");
  p.stdin.end();
  const code = await p.exited;
  return { code, stdout: await new Response(p.stdout).text(), stderr: await new Response(p.stderr).text() };
}

test("migration seals secrets.json and leaves the original file alone", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mig-"));
  const src = join(dir, "secrets.json"), out = join(dir, "vault.age");
  writeFileSync(src, JSON.stringify({ listenerToken: "abc" }));

  const r = await migrate(["--in", src, "--out", out], "my phrase");
  expect(r.code).toBe(0);

  const opened = JSON.parse(openVault(readFileSync(out), "my phrase")) as { listenerToken: string };
  expect(opened.listenerToken).toBe("abc");
  expect(readFileSync(src, "utf8")).toContain("abc");   // the original MUST NOT be deleted
});

test("an empty passphrase rejects the migration", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mig-"));
  const src = join(dir, "secrets.json");
  writeFileSync(src, JSON.stringify({ a: 1 }));
  const r = await migrate(["--in", src, "--out", join(dir, "v.age")], "");
  expect(r.code).not.toBe(0);
});

test("invalid JSON is not sealed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mig-"));
  const src = join(dir, "secrets.json");
  writeFileSync(src, "{this is not json");
  const r = await migrate(["--in", src, "--out", join(dir, "v.age")], "phrase");
  expect(r.code).not.toBe(0);
});
