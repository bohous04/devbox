import { expect, test } from "bun:test";
import { sessionGitTokens } from "../src/sessions";

const inst = [{ name: "infra", url: "http://git.example.com:3000" }];
const issue = (session: string, instance: string) => `devbox-${session}-${instance}-FAKE`;

test("the file for the container carries a placeholder, not the real token", () => {
  const out = sessionGitTokens(inst, "dev-p-r", issue, "http://172.17.0.1:4300");
  expect(out).toEqual({ "172.17.0.1:4300": "devbox-dev-p-r-infra-FAKE" });
});

test("the key is the devd host, because that is where git goes now", () => {
  const out = sessionGitTokens(inst, "dev-p-r", issue, "http://host.docker.internal:4300");
  expect(Object.keys(out)).toEqual(["host.docker.internal:4300"]);
});

test("without instances the file is empty, not broken", () => {
  expect(sessionGitTokens([], "dev-p-r", issue, "http://172.17.0.1:4300")).toEqual({});
});

test("an unparsable devd address does not take the session down", () => {
  expect(sessionGitTokens(inst, "dev-p-r", issue, "this is not a url")).toEqual({});
});
