import { expect, test } from "bun:test";
import { insteadOfArgs, insteadOfEnv } from "../src/gitProxy";

const inst = [{ name: "infra", url: "http://198.51.100.7:3000" }];

test("maps the Gitea address to the proxy path", () => {
  expect(insteadOfArgs(inst, "http://172.17.0.1:4300")).toEqual([[
    "git", "config", "--global",
    "url.http://172.17.0.1:4300/git/infra/.insteadOf",
    "http://198.51.100.7:3000/",
  ]]);
});

test("trailing slashes are not doubled", () => {
  const a = insteadOfArgs([{ name: "infra", url: "http://g.example.com/" }], "http://d:4300/");
  expect(a[0]![3]).toBe("url.http://d:4300/git/infra/.insteadOf");
  expect(a[0]![4]).toBe("http://g.example.com/");
});

test("the entrypoint env carries name=url pairs", () => {
  expect(insteadOfEnv([...inst, { name: "druha", url: "http://x:3000" }]))
    .toBe("infra=http://198.51.100.7:3000,druha=http://x:3000");
});

test("without instances the env is empty, not 'undefined'", () => {
  expect(insteadOfEnv([])).toBe("");
});
