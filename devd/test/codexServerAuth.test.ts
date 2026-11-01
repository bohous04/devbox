import { expect, test } from "bun:test";
import { codexHomeFromEnvironment, codexServerHome } from "../src/codexServerAuth";

test("CODEX_HOME from the service environment, the drop-in (last assignment) wins", () => {
  const env = "HOME=/home/dev CODEX_HOME=/var/lib/codex-remote-home PATH=/usr/local/bin:/usr/bin:/bin DEVD_CODEX_RUNTIME_DIR=/home/dev/.codex/devbox-runtime";
  expect(codexHomeFromEnvironment(env)).toBe("/var/lib/codex-remote-home");
  expect(codexHomeFromEnvironment("CODEX_HOME=/a CODEX_HOME=/b")).toBe("/b");
  expect(codexHomeFromEnvironment('CODEX_HOME="/x y"')).toBe("/x y");
});

test("without CODEX_HOME or with a suspicious path, nothing", () => {
  expect(codexHomeFromEnvironment("HOME=/home/dev DEVD_CODEX_HOME=/nope")).toBeNull();
  expect(codexHomeFromEnvironment("")).toBeNull();
  expect(codexHomeFromEnvironment("CODEX_HOME=relative")).toBeNull();
  expect(codexHomeFromEnvironment("CODEX_HOME=/a/../etc")).toBeNull();
});

test("a disabled server has no live login — nobody refreshes its auth.json", () => {
  const env = "HOME=/home/dev CODEX_HOME=/var/lib/codex-remote-home PATH=/usr/bin";
  expect(codexServerHome(`ActiveState=active\nEnvironment=${env}\n`)).toBe("/var/lib/codex-remote-home");
  expect(codexServerHome(`Environment=${env}\nActiveState=inactive\n`)).toBeNull();
  expect(codexServerHome(`ActiveState=failed\nEnvironment=${env}\n`)).toBeNull();
  expect(codexServerHome(`Environment=${env}\n`)).toBeNull();
  expect(codexServerHome("ActiveState=active\nEnvironment=HOME=/home/dev\n")).toBeNull();
});
