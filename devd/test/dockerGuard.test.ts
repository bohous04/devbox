import { expect, test } from "bun:test";
import { dockerTestsAllowed } from "./helpers/docker";

test("docker tests are skipped on a host with the production devd", () => {
  expect(dockerTestsAllowed({}, (p) => p === "/var/lib/devd/devd.sqlite")).toBe(false);
  expect(dockerTestsAllowed({}, (p) => p === "/etc/devd")).toBe(false);
});

test("outside the production host they run, forcing them is only explicit", () => {
  expect(dockerTestsAllowed({}, () => false)).toBe(true);
  expect(dockerTestsAllowed({ DEVD_TEST_DOCKER: "force" }, () => true)).toBe(true);
  expect(dockerTestsAllowed({ DEVD_TEST_DOCKER: "1" }, () => true)).toBe(false);
});
