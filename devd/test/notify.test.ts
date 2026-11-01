import { expect, test } from "bun:test";
import { diskWarnMessage, pushOptsFor, shouldWarnDisk } from "../src/notify";
import { EMERGENCY } from "../src/pushover";

const H = 3600_000;
test("shouldWarnDisk fires over threshold and de-dupes for 6h", () => {
  const now = 100 * H;
  expect(shouldWarnDisk(85, 100, 80, 0, now)).toBe(true);
  expect(shouldWarnDisk(70, 100, 80, 0, now)).toBe(false);           // under threshold
  expect(shouldWarnDisk(85, 100, 80, now - 3 * H, now)).toBe(false); // warned 3h ago
  expect(shouldWarnDisk(85, 100, 80, now - 7 * H, now)).toBe(true);  // 7h ago → warn again
});

test("diskWarnMessage text", () => {
  expect(diskWarnMessage(1_700_000_000_000, 2_000_000_000_000, 7)).toContain("Disk at 85%");
  expect(diskWarnMessage(1_700_000_000_000, 2_000_000_000_000, 7)).toContain("~7 days");
  expect(diskWarnMessage(100, 200, null)).toContain("plenty of space");
});

const DASH = "https://dev.example.cz";

test("pushOptsFor: session → deep link to the terminal, important → EMERGENCY", () => {
  const o = pushOptsFor({ session: { id: "dev-a-b", project: "a", repo: "b" }, important: true }, DASH);
  expect(o).toMatchObject({ ...EMERGENCY, url: `${DASH}/sessions?terminal=dev-a-b`, url_title: "Open terminal" });
  expect(pushOptsFor(undefined, DASH)).toEqual({});
});

test("pushOptsFor: target → dashboard page (Pushover) + target/targetId/blocked (APNs)", () => {
  expect(pushOptsFor({ target: { kind: "prodWrites", id: "7" }, blocked: true }, DASH))
    .toEqual({ url: `${DASH}/prod-writes`, url_title: "Open in dashboard", target: "prodWrites", targetId: "7", blocked: true });
  expect(pushOptsFor({ target: { kind: "sshApprovals", id: "x1" } }, DASH)).toMatchObject({ url: `${DASH}/ssh-approvals`, target: "sshApprovals", targetId: "x1" });
  expect(pushOptsFor({ target: { kind: "schedules" } }, DASH)).toMatchObject({ url: `${DASH}/cron`, target: "schedules" });
  expect(pushOptsFor({ target: { kind: "subscriptions" } }, DASH)).toMatchObject({ url: `${DASH}/subscriptions`, target: "subscriptions" });
  expect(pushOptsFor({ target: { kind: "vault" } }, DASH)).toMatchObject({ url: `${DASH}/`, target: "vault" });
  expect("targetId" in pushOptsFor({ target: { kind: "vault" } }, DASH)).toBe(false);
});

test("pushOptsFor: session takes precedence over the target in the URL", () => {
  const o = pushOptsFor({ session: { id: "s1", project: "a", repo: "b" }, target: { kind: "schedules" } }, DASH);
  expect(o.url).toBe(`${DASH}/sessions?terminal=s1`);
  expect(o.target).toBe("schedules");
});

test("pushOptsFor: without a dashboard URL the push carries no link, but keeps target metadata", () => {
  const opts = pushOptsFor({ session: { id: "dev-shop-cms" } as never, target: { kind: "vault" } } as never, "");
  expect(opts.url).toBeUndefined();
  expect(opts.url_title).toBeUndefined();
  expect(opts.target).toBe("vault");
});
