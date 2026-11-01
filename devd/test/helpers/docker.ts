import { existsSync } from "node:fs";
import { sh } from "./sh";

// Docker tests create real containers (`dev-shop-<pid>-app`, alpine:3, workspace
// in /tmp). On the host running the production devd they would end up next to live sessions — and when a test
// crashes before cleanup, they stay there. Exactly that happened on 2026-10-03: two forgotten test
// containers blocked the Codex Remote registry sync (sync.py refused a "changed workspace")
// for two days, so sessions could be neither ended nor restored. That is why docker tests are
// skipped on the production host; they can only be forced deliberately via DEVD_TEST_DOCKER=force.
export const PRODUCTION_DEVD_MARKERS = ["/var/lib/devd/devd.sqlite", "/etc/devd"];

export function dockerTestsAllowed(
  env: Record<string, string | undefined> = process.env,
  exists: (path: string) => boolean = existsSync,
): boolean {
  if (env.DEVD_TEST_DOCKER === "force") return true;
  return !PRODUCTION_DEVD_MARKERS.some(exists);
}

export const hasDocker = dockerTestsAllowed() && sh(process.cwd(), "docker", "info").code === 0;

// Suffix for container/volume names of one suite run. The PID alone is not enough: PIDs get
// recycled and a run killed before cleanup leaves containers `dev-<project>-<pid>-…`
// behind, which a later run with the same PID would trip over ("name already in use").
export const RUN_ID = `${process.pid}-${crypto.randomUUID().slice(0, 6)}`;

/** Removes all containers whose name starts with `prefix` (cleanup after a crashed test). */
export function removeContainers(prefix: string): void {
  const ids = sh(process.cwd(), "docker", "ps", "-aq", "--filter", `name=^${prefix}`).stdout.split("\n").filter(Boolean);
  if (ids.length) sh(process.cwd(), "docker", "rm", "-f", ...ids);
}

/** Start of the host port range for one run's docker tests. A random block of 100
 *  (one test creates up to several sessions with blocks of ≤ 10, see ports.ts), not derived
 *  from the PID: nearby PIDs of concurrent runs used to give overlapping ranges ("port is already
 *  allocated"). Two concurrent runs thus collide 1 in 100. The range 20000–29999 lies below
 *  the ephemeral ports of Linux (32768+) and macOS (49152+) — otherwise outgoing
 *  connections of other tests sometimes hold it ("address already in use"). */
export function testPortBase(): number {
  return 20000 + Math.floor(Math.random() * 100) * 100;
}
