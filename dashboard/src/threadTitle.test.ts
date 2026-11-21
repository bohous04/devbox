import { expect, test } from "bun:test";
import { threadTitle } from "../../shared/threadTitle";
import cases from "../../shared/fixtures/thread-titles.json";

/** shared/fixtures/thread-titles.json: devd's inbox `topic` uses this rule, and the Apple apps' copy (ThreadTitle,
 *  ChatLayoutTests) runs the same cases. */
test("threadTitle: the first clause that reads as words, at most six words; commands and code are skipped", () => {
  for (const c of cases) expect([c.message, threadTitle(c.message)]).toEqual([c.message, c.title]);
});
