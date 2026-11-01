import { expect, test } from "bun:test";
import { detectedWarpGrokSupport, WARP_BLOCK, warpBlockOption, warpClientSupportsGrok, warpGrokOption } from "../src/warp";
import { tmuxCommand } from "../src/attach";

test("Grok detection follows the shipped desktop build, including stable suffixes", () => {
  for (const v of ["0.2026.08.26.17.59.01", "v0.2026.09.02.08.27.stable_01", "unknown", ""]) {
    expect(warpClientSupportsGrok(v)).toBe(false);
  }
  for (const v of ["0.2026.09.09.08.26.02", "v0.2026.09.09.08.26.stable_02", "0.2026.10.01.00.00"]) {
    expect(warpClientSupportsGrok(v)).toBe(true);
  }
});

test("running Warp version wins over a newly installed bundle", async () => {
  expect(await detectedWarpGrokSupport({ WARP_CLIENT_VERSION: "0.2026.08.26.17.59.01" }, "darwin",
    async () => { throw new Error("must not read the installed version"); })).toBe(false);
  expect(await detectedWarpGrokSupport({ TERM_PROGRAM: "WarpTerminal" }, "darwin",
    async () => "0.2026.09.09.08.26.02")).toBe(true);
  expect(await detectedWarpGrokSupport({}, "darwin", async () => "0.2026.09.09.08.26.02")).toBeUndefined();
});

test("each attached tmux session gets an exact isolated capability", () => {
  expect(warpGrokOption(true, "main-2")).toContain("-t main-2 @devd_warp_grok_native 1");
  expect(warpGrokOption(false, "main")).toContain("@devd_warp_grok_native 0");
  expect(warpGrokOption(true, "reviewer")).toContain("-t reviewer @devd_warp_grok_native 1");
  expect(warpGrokOption(undefined, "main")).toBe("");
  expect(() => warpGrokOption(true, "main; evil")).toThrow();
});

test("inside Warp every attach of one dev process carries the same block id", () => {
  expect(warpBlockOption(true, "main-2", "123-abc")).toBe("tmux set-option -t main-2 @devd_warp_block 123-abc 2>/dev/null");
  expect(warpBlockOption(false, "main")).toContain(`@devd_warp_block ${WARP_BLOCK}`);
  expect(warpBlockOption(undefined, "main")).toBe("");
  expect(() => warpBlockOption(true, "main", "x; evil")).toThrow();
  expect(() => warpBlockOption(true, "main; evil")).toThrow();
  const cmd = tmuxCommand("main", true);
  expect(cmd).toContain(`@devd_warp_block ${WARP_BLOCK}`);
  expect(cmd.indexOf("@devd_warp_block")).toBeLessThan(cmd.indexOf("tmux attach"));
  expect(tmuxCommand("main")).not.toContain("@devd_warp_block");
});
