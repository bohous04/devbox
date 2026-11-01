import { expect, test } from "bun:test";
import { deepLinkHash, terminalTabUrl } from "./terminalRoute";

// HashRouter: the path must be in the hash — the path form `/terminal/x` falls to the catch-all
// (Overview). Exactly this mix-up broke the Terminal button after PR #53.
test("terminalTabUrl: hash address, id encoded", () => {
  expect(terminalTabUrl("dev-shop-cms")).toBe("/#/terminal/dev-shop-cms");
  expect(terminalTabUrl("dev a/b")).toBe("/#/terminal/dev%20a%2Fb");
});

test("deepLinkHash: ?terminal=<id> → terminal hash, otherwise null", () => {
  expect(deepLinkHash("?terminal=dev-shop-cms")).toBe("/#/terminal/dev-shop-cms");
  expect(deepLinkHash("?terminal=dev%20a")).toBe("/#/terminal/dev%20a");
  expect(deepLinkHash("")).toBeNull();
  expect(deepLinkHash("?open=dev-x")).toBeNull();
});
