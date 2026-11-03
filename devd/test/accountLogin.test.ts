import { expect, test } from "bun:test";
import { AccountLogin } from "../src/accountLogin";

function fixture() {
  const calls: { cmd: string[]; input?: string }[] = [];
  const saved: { id: string; credentials: string }[] = [];
  let exit: string | null = null;
  let running = true;
  const login = new AccountLogin({
    sleep: async () => {},
    run: async (cmd, input) => {
      calls.push({ cmd, input });
      const s = cmd.join(" ");
      if (s.includes("capture-pane")) return { code: 0, stdout: "https://claude.com/cai/oauth/authorize?state=s", stderr: "" };
      if (cmd[0] === "exec" && cmd.at(-1) === "/tmp/account-login.exit") return { code: exit === null ? 1 : 0, stdout: exit ?? "", stderr: "" };
      if (cmd[0] === "inspect") return { code: 0, stdout: String(running), stderr: "" };
      if (cmd[0] === "exec" && cmd.at(-1)?.endsWith(".credentials.json")) return { code: 0, stdout: "secret-json", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
  }, async (id, credentials) => { saved.push({ id, credentials }); });
  return { login, calls, saved, finish: (code = "0") => { exit = code; }, expire: () => { running = false; } };
}

test("isolated login saves server-side only after successful exit, then removes container", async () => {
  const f = fixture();
  expect(await f.login.start("extra")).toEqual({ url: "https://claude.com/cai/oauth/authorize?state=s" });
  expect(f.calls[0].cmd).toContain("--tmpfs");
  expect(f.calls[0].cmd).not.toContain("-v");
  expect(await f.login.status("extra")).toBe("pending");
  expect(f.saved).toHaveLength(0);
  await f.login.code("extra", "code#state");
  expect(f.calls.find((x) => x.input)?.input).toBe("code#state");
  f.finish();
  expect(await f.login.status("extra")).toBe("done");
  expect(f.saved).toEqual([{ id: "extra", credentials: "secret-json" }]);
  expect(f.calls.at(-1)?.cmd.slice(0, 2)).toEqual(["rm", "-f"]);
  expect(await f.login.status("extra")).toBe("done");
  expect(f.saved).toHaveLength(1);
  expect(f.calls.some((c) => c.cmd.includes("secret-json"))).toBe(false);
});

test("overlapping starts and wrong account code cannot hijack a pending login", async () => {
  const f = fixture();
  await f.login.start("first");
  await expect(f.login.start("second")).rejects.toThrow("already running");
  await expect(f.login.code("second", "code")).rejects.toThrow();
  await expect(f.login.code("first", "bad\ncode")).rejects.toThrow();
  await f.login.cancel("first");
  expect(await f.login.status("first")).toBe("error");
  expect(f.saved).toHaveLength(0);
});

for (const failure of ["exit", "expired"] as const) test(`${failure} cleans up without registering an account`, async () => {
  const f = fixture();
  await f.login.start("extra");
  if (failure === "exit") f.finish("1"); else f.expire();
  expect(await f.login.status("extra")).toBe("error");
  expect(f.saved).toHaveLength(0);
  expect(f.calls.at(-1)?.cmd.slice(0, 2)).toEqual(["rm", "-f"]);
});
