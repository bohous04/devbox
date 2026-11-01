import { expect, test } from "bun:test";
import { provisionCommand, type ProvisionInput } from "../src/dbProvision";

const input: ProvisionInput = {
  sshAlias: "shop-root-hardened", container: "eshop-pg", engine: "postgres",
  db: "eshop", roUser: "eshop_ro", hostPort: 15502, opItem: "prod-ro eshop", opVault: "VPS shop",
};

test("builds the command with all required flags", () => {
  const c = provisionCommand(input);
  expect(c).toStartWith("bash tools/prod-db-provision.sh");   // bun does not run the shell script

  // All values are quoted, not just those with a space — a uniform rule cannot be forgotten.
  for (const f of ["--server 'shop-root-hardened'", "--container 'eshop-pg'", "--engine postgres",
                   "--db 'eshop'", "--ro-user 'eshop_ro'", "--host-port 15502"]) {
    expect(c).toContain(f);
  }
});

test("items with spaces are quoted, otherwise the command would fall apart", () => {
  expect(provisionCommand(input)).toContain(`--op-item 'prod-ro eshop'`);
  expect(provisionCommand(input)).toContain(`--op-vault 'VPS shop'`);
});

test("the optional vault is omitted when not given", () => {
  const c = provisionCommand({ ...input, opVault: undefined });
  expect(c).not.toContain("--op-vault");
});

test("an apostrophe in a value does not escape the quotes", () => {
  const c = provisionCommand({ ...input, opItem: "prod'ro" });
  expect(c).not.toMatch(/--op-item 'prod'ro'/);
});

test("an empty required field is rejected rather than building a broken command", () => {
  expect(() => provisionCommand({ ...input, db: "" })).toThrow(/db/);
});

test("an out-of-range port is rejected", () => {
  expect(() => provisionCommand({ ...input, hostPort: 0 })).toThrow(/port/i);
});

test("the write role goes into the command only on request", () => {
  const c = provisionCommand({ ...input, rwUser: "eshop_rw", rwOpItem: "prod-rw eshop" });
  expect(c).toContain("--rw-user 'eshop_rw'");
  expect(c).toContain("--rw-op-item 'prod-rw eshop'");
  expect(provisionCommand(input)).not.toContain("--rw-user");
});

test("a write role without a 1P item is rejected — the script would not accept it anyway", () => {
  expect(() => provisionCommand({ ...input, rwUser: "eshop_rw" })).toThrow(/rwOpItem/);
});
