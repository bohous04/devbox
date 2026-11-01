import { expect, test } from "bun:test";
import { clipToBytes } from "../src/textBudget";

const bytes = (s: string) => Buffer.byteLength(s, "utf8");

test("short text is only cleaned: control characters become spaces, ends are trimmed", () => {
  expect(clipToBytes("  a\tb\nc\u0007  ", 70)).toBe("a b c");
  expect(clipToBytes("x".repeat(70), 70)).toBe("x".repeat(70));
});

test("long text is cut to the byte budget, ellipsis included", () => {
  const out = clipToBytes("x".repeat(71), 70);
  expect(out).toBe("x".repeat(67) + "…");
  expect(bytes(out)).toBe(70);
});

test("multi-byte characters are never split", () => {
  for (const sample of ["😀".repeat(100), "ñ".repeat(100), "a😀".repeat(50), '😄"\\'.repeat(2000)]) {
    for (const limit of [10, 40, 70, 160]) {
      const out = clipToBytes(sample, limit);
      expect(bytes(out)).toBeLessThanOrEqual(limit);
      expect(out).not.toContain("�");
      expect(Array.from(out.slice(0, -1)).join("")).toBe(out.slice(0, -1));   // no lone surrogate
      expect(out.endsWith("…")).toBe(true);
    }
  }
});

test("whitespace before the cut is dropped so the ellipsis follows a word", () => {
  expect(clipToBytes("abc " + "d".repeat(80), 7)).toBe("abc…");
});
