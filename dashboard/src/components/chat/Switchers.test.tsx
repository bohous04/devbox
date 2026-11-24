import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ChatTarget } from "../../api";
import { TargetReader } from "../../switchView";
import { SwitcherStatus } from "./Switchers";

const AWAITING: ChatTarget = {
  agent: "claude", harness: "claude", account: "a1", model: "claude-opus-5-5", awaitingTarget: true, bridgeVersion: "1.11.0", bridgeOutdated: false,
};
const WAITING_LINE = "Agent is waiting for a target";

/** A read whose answer the test gives. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function reader() {
  const reads: ReturnType<typeof deferred<ChatTarget>>[] = [];
  const got: (ChatTarget | string)[] = [];
  const r = new TargetReader(() => { const d = deferred<ChatTarget>(); reads.push(d); return d.promise; }, (t) => got.push(t), (e) => got.push(String(e)));
  return { r, reads, got };
}

test("TargetReader: a poll tick while a read is in flight is skipped", async () => {
  const { r, reads, got } = reader();
  void r.load();
  r.poll();
  r.poll();
  expect(reads).toHaveLength(1);
  reads[0]!.resolve(AWAITING);
  await Bun.sleep(0);
  expect(got).toEqual([AWAITING]);
  r.poll();
  expect(reads).toHaveLength(2);
});

test("TargetReader: an older answer that comes after a newer one is dropped (awaiting true never overwrites false)", async () => {
  const { r, reads, got } = reader();
  void r.load(); // e.g. the poll
  void r.load(); // a trigger (a run ended), started later
  const settled = { ...AWAITING, awaitingTarget: false };
  reads[1]!.resolve(settled);
  await Bun.sleep(0);
  reads[0]!.resolve(AWAITING);
  await Bun.sleep(0);
  expect(got).toEqual([settled]);
});

test("TargetReader: an older failure is dropped too; the newest one is reported", async () => {
  const { r, reads, got } = reader();
  void r.load();
  void r.load();
  reads[0]!.reject(new Error("old"));
  reads[1]!.reject(new Error("new"));
  await Bun.sleep(0);
  expect(got).toEqual(["Error: new"]);
});

test("TargetReader: Retry (load) always reads, also while a poll is in flight", async () => {
  const { r, reads } = reader();
  r.poll();
  void r.load();
  expect(reads).toHaveLength(2);
});

const status = (o: Partial<Parameters<typeof SwitcherStatus>[0]>) =>
  renderToStaticMarkup(<SwitcherStatus target={AWAITING} targetErr={null} note={null} err={null} onRetry={() => {}} {...o} />);

test("SwitcherStatus: the waiting line while the bridge awaits its target", () => {
  const html = status({});
  expect(html).toContain(WAITING_LINE);
  expect(html).not.toContain("Retry");
});

test("SwitcherStatus: a failed re-read hides the waiting line and shows the error with Retry", () => {
  const html = status({ targetErr: "Could not read the current agent: offline" });
  expect(html).not.toContain(WAITING_LINE);
  expect(html).toContain("Could not read the current agent: offline");
  expect(html).toContain("Retry");
});

test("SwitcherStatus: before any target, only the error with Retry", () => {
  expect(status({ target: null })).toBe("");
  const html = status({ target: null, targetErr: "Could not read the current agent: offline" });
  expect(html).toContain("Retry");
  expect(html).not.toContain(WAITING_LINE);
});
