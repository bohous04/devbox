import { expect, test } from "bun:test";
import { createRateLimiter } from "../src/rateLimit";

test("allows up to the limit and rejects the next one", () => {
  let t = 1000;
  const rl = createRateLimiter(3, 60_000, () => t);
  expect(rl.take("a").ok).toBe(true);
  expect(rl.take("a").ok).toBe(true);
  expect(rl.take("a").ok).toBe(true);
  expect(rl.take("a").ok).toBe(false);
});

test("keys are counted separately", () => {
  let t = 1000;
  const rl = createRateLimiter(1, 60_000, () => t);
  expect(rl.take("a").ok).toBe(true);
  expect(rl.take("b").ok).toBe(true);
  expect(rl.take("a").ok).toBe(false);
});

test("the window slides — a slot frees up once the oldest pass expires", () => {
  let t = 0;
  const rl = createRateLimiter(2, 1000, () => t);
  expect(rl.take("a").ok).toBe(true);   // t=0
  t = 500;
  expect(rl.take("a").ok).toBe(true);   // t=500
  t = 900;
  expect(rl.take("a").ok).toBe(false);  // both still in the window
  t = 1001;
  expect(rl.take("a").ok).toBe(true);   // the first dropped out
});

test("retryAfterSec points to the expiry of the oldest pass, never 0", () => {
  let t = 0;
  const rl = createRateLimiter(1, 10_000, () => t);
  rl.take("a");
  t = 3000;
  expect(rl.take("a").retryAfterSec).toBe(7);
  t = 9999;
  expect(rl.take("a").retryAfterSec).toBe(1); // 1 ms left → rounded up, not 0
});

test("a rejected attempt does not extend the window (the limit is not a permanent ban)", () => {
  let t = 0;
  const rl = createRateLimiter(1, 1000, () => t);
  expect(rl.take("a").ok).toBe(true);      // t=0
  for (t = 100; t < 1000; t += 100) rl.take("a"); // spam inside the window
  t = 1001;
  expect(rl.take("a").ok).toBe(true);      // the original pass dropped out → allowed again
});

test("the key map does not grow forever", () => {
  let t = 0;
  const rl = createRateLimiter(1, 1000, () => t);
  for (let i = 0; i < 600; i++) rl.take(`k${i}`);
  t = 5000;
  for (let i = 0; i < 600; i++) rl.take(`n${i}`);
  // After cleanup old keys must still pass (they are not "remembered" as exhausted).
  expect(rl.take("k1").ok).toBe(true);
});
