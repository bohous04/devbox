// Waiting for a condition instead of a fixed sleep: under load (CI, concurrent runs) a fixed
// pause is either not enough or needlessly slows the test. Throws after `timeoutMs`.
export async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 4000, stepMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error(`waitFor: condition not met within ${timeoutMs} ms`);
    await Bun.sleep(stepMs);
  }
}
