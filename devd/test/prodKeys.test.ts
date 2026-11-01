import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProdKeyPath } from "../src/prodKeys";

test("concurrent calls for the same key share one readKey and one write (in-flight cache)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prod-keys-"));
  let calls = 0;
  const readKey = async (key: string) => {
    calls++;
    await new Promise((r) => setTimeout(r, 20));
    return `KEY-${key}\n`;
  };
  const keyPath = createProdKeyPath(dir, readKey);

  const [a, b] = await Promise.all([keyPath("prod-tunnel-shop"), keyPath("prod-tunnel-shop")]);
  expect(calls).toBe(1);
  expect(a).toBe(b);
  expect(readFileSync(a, "utf8")).toBe("KEY-prod-tunnel-shop\n");
});

test("a readKey failure is not cached — the next call tries again", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prod-keys-"));
  let calls = 0;
  const readKey = async (key: string) => {
    calls++;
    if (calls === 1) throw new Error("op mimo");
    return `KEY-${key}\n`;
  };
  const keyPath = createProdKeyPath(dir, readKey);

  await expect(keyPath("prod-tunnel-shop")).rejects.toThrow("op mimo");
  const p = await keyPath("prod-tunnel-shop");
  expect(calls).toBe(2);
  expect(readFileSync(p, "utf8")).toBe("KEY-prod-tunnel-shop\n");
});

test("chown is called with the final path after the write", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prod-keys-"));
  const chowned: string[] = [];
  const keyPath = createProdKeyPath(dir, async (key) => `KEY-${key}\n`, (p) => { chowned.push(p); });

  const p = await keyPath("prod-tunnel-shop");
  expect(chowned).toEqual([p]);
});
