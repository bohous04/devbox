import { expect, test } from "bun:test";
import { threadTitle } from "./threadTitle";

test("threadTitle: the first clause that reads as words, at most six words", () => {
  expect(threadTitle("Small offline sync task for the notes app: queue edits in queue.ts and replay them")).toBe("Small offline sync task for the…");
  expect(threadTitle("Fix the flaky checkout test.\nMore detail here")).toBe("Fix the flaky checkout test");
  expect(threadTitle("rate limit the search endpoint")).toBe("Rate limit the search endpoint");
});

test("threadTitle: commands and code are skipped", () => {
  expect(threadTitle("Run: for i in 1 2 3 4 5 6 7 8; do echo step $i; sleep 5; done — then tell me the last step number."))
    .toBe("Then tell me the last step…");
  expect(threadTitle("Please run `bun test` and report")).toBe("Please run and report");
  expect(threadTitle("\n\n  Look at https://example.com/x then fix it")).toBe("Look at then fix it");
});

test("threadTitle: nothing usable gives null", () => {
  expect(threadTitle("")).toBeNull();
  expect(threadTitle("`ls -la`")).toBeNull();
  expect(threadTitle("$ x=1")).toBeNull();
});
