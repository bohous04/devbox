import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_FILE_BYTES, attachLaunchConfig, clipboardPngScript, focusWarpScript, mapPath, realActions } from "../src/actions";

const maps = [{ from: "/srv/dev", to: "/Volumes/dev" }];

test("mapPath maps prefix at path boundary only", () => {
  expect(mapPath(maps, "/srv/dev/acme/shop/cms/review.md")).toBe("/Volumes/dev/acme/shop/cms/review.md");
  expect(mapPath(maps, "/srv/dev")).toBe("/Volumes/dev");
  expect(mapPath(maps, "/srv/devil/x")).toBeNull();
  expect(mapPath(maps, "/etc/passwd")).toBeNull();
});

test("mapPath rejects .. and . traversal segments", () => {
  expect(mapPath(maps, "/srv/dev/../../../etc/hosts")).toBeNull();
  expect(mapPath(maps, "/srv/dev/a/../../../etc")).toBeNull();
  expect(mapPath(maps, "/srv/dev/./x")).toBeNull();
});

test("actions build correct commands via injected spawner", () => {
  const calls: string[][] = [];
  // notifierBin=null forces the osascript path regardless of what's installed locally
  const a = realActions((...cmd) => { calls.push(cmd); return { code: 0 }; }, null);
  a.open("/Volumes/dev/x.md");
  a.notify("devbox", 'conflict "test"');
  // Only reveal in Finder — `open` without -R would run a .command/.app from the SMB volume.
  expect(calls[0]).toEqual(["open", "-R", "/Volumes/dev/x.md"]);
  expect(calls[1][0]).toBe("osascript");
  expect(calls[1][2]).toContain('with title "devbox"');
  expect(calls[1][2]).toContain('\\"test\\"');
});

test("notify prefers the notifier app when present", () => {
  const calls: string[][] = [];
  const bin = import.meta.path; // an existing file so existsSync passes
  const a = realActions((...cmd) => { calls.push(cmd); return { code: 0 }; }, bin);
  a.notify("devbox", "hello");
  expect(calls[0]).toEqual([bin, "devbox", "hello"]);
});

test("notify falls back to osascript when the notifier exits non-zero", () => {
  const calls: string[][] = [];
  const bin = import.meta.path;
  const a = realActions((...cmd) => { calls.push(cmd); return { code: cmd[0] === bin ? 1 : 0 }; }, bin);
  a.notify("devbox", "hello");
  expect(calls[0][0]).toBe(bin);
  expect(calls[1][0]).toBe("osascript");
});

test("notify builds argv with --sound and --user-info", () => {
  const calls: string[][] = [];
  const run = (...cmd: string[]) => { calls.push(cmd); return { code: 0 }; };
  const a = realActions(run, "/tmp/devbox-notify-test-bin-exists-not"); // does not exist → osascript fallback
  a.notify("t", "m", { sound: true, session: { id: "dev-a-b", project: "a", repo: "b" } });
  expect(calls[0][0]).toBe("osascript"); // the fallback ignores opts

  // with an existing binary (we satisfy existsSync with a real file)
  const bin = join(mkdtempSync(join(tmpdir(), "ntf-")), "devbox-notify");
  writeFileSync(bin, "#!/bin/sh\nexit 0\n");
  const calls2: string[][] = [];
  const a2 = realActions((...cmd) => { calls2.push(cmd); return { code: 0 }; }, bin);
  a2.notify("⏸️ a/b", "Claude is waiting for permission", { sound: true, session: { id: "dev-a-b", project: "a", repo: "b" } });
  expect(calls2[0]).toEqual([bin, "⏸️ a/b", "Claude is waiting for permission", "--sound", "--user-info", JSON.stringify({ id: "dev-a-b", project: "a", repo: "b" })]);
});

test("openUrl runs open with the URL", () => {
  const calls: string[][] = [];
  const a = realActions((...cmd) => { calls.push(cmd); return { code: 0 }; }, null);
  expect(a.openUrl("http://100.64.0.10:40100/").code).toBe(0);
  expect(calls).toContainEqual(["open", "http://100.64.0.10:40100/"]);
});

test("focusWarpScript searches for the needle and ends with error number 1 when not found", () => {
  const s = focusWarpScript('cms"; do shell script "evil');
  expect(s).toContain('contains "cms\\"; do shell script \\"evil"'); // quotes escaped
  expect(s.trim().endsWith("error number 1")).toBe(true);
  expect(s).toContain('tell application "System Events"');
  expect(s).toContain("AXRaise");
});

test("attachLaunchConfig contains dev attach <id>", () => {
  const y = attachLaunchConfig("dev-shop-cms");
  expect(y).toContain("exec: dev attach dev-shop-cms");
  expect(y).toContain("name: devbox-attach");
});

test("focusWarp/openWarpAttach/openDashboard", () => {
  const calls: string[][] = [];
  const written: [string, string][] = [];
  const a = realActions((...cmd) => { calls.push(cmd); return { code: cmd[0] === "osascript" ? 1 : 0 }; }, null, {
    launchDir: "/tmp/lc", dashboardUrl: "https://dev.example.com",
    writeFile: (p, c) => { written.push([p, c]); },
  });
  expect(a.focusWarp("cms")).toBe(false);        // osascript code 1 = not found
  expect(a.openWarpAttach("dev-shop-cms").code).toBe(0);
  expect(written[0][0]).toBe("/tmp/lc/devbox-attach.yaml");
  expect(written[0][1]).toContain("dev attach dev-shop-cms");
  expect(calls.at(-1)).toEqual(["open", "warp://launch/devbox-attach.yaml"]);
  expect(a.openDashboard().code).toBe(0);
  expect(calls.at(-1)).toEqual(["open", "https://dev.example.com"]);
  const b = realActions(() => ({ code: 0 }), null, { writeFile: () => {} });
  expect(b.openDashboard().code).toBe(0); // without dashboardUrl a no-op (no open)
});

function clipFixture(over: Partial<{ info: { code: number; stdout: string }; pb: { code: number; stdout: string }; png: number; readFile?: (p: string) => Uint8Array }> = {}) {
  const calls: string[][] = [];
  const removed: string[] = [];
  const out = (...cmd: string[]) => {
    calls.push(cmd);
    if (cmd[0] === "pbpaste") return over.pb ?? { code: 0, stdout: "hello" };
    if (cmd[1] === "-e" && cmd[2] === "clipboard info") return over.info ?? { code: 0, stdout: "«class PNGf», 1234, string, 4" };
    return { code: over.png ?? 0, stdout: "" }; // osascript PNG write
  };
  const files = new Map<string, Uint8Array>();
  const clip = {
    out,
    tmpFile: () => "/tmp/clip-test.png",
    readFile: over.readFile ?? ((p: string) => files.get(p) ?? new Uint8Array([137, 80, 78, 71])),
    rm: (p: string) => { removed.push(p); files.delete(p); },
    bin: null, // force the osascript path (regardless of whether the helper is built on this machine)
  };
  const a = realActions(() => ({ code: 0 }), null, {}, clip);
  return { a, calls, removed };
}

// Forced helper path (clip.bin set) — reads go through the compiled binary.
function clipHelperFixture(over: Partial<{ targets: { code: number; stdout: string }; text: { code: number; stdout: string }; image: number }> = {}) {
  const calls: string[][] = [];
  const removed: string[] = [];
  const files = new Map<string, Uint8Array>();
  const out = (...cmd: string[]) => {
    calls.push(cmd);
    if (cmd[1] === "targets") return over.targets ?? { code: 0, stdout: "image/png\ntext/plain\n" };
    if (cmd[1] === "text") return over.text ?? { code: 0, stdout: "helper text" };
    if (cmd[1] === "image") {
      const code = over.image ?? 0;
      if (code === 0) files.set(cmd[2], new Uint8Array([137, 80, 78, 71]));
      return { code, stdout: "" };
    }
    return { code: 1, stdout: "" };
  };
  const clip = {
    out,
    tmpFile: () => "/tmp/h.png",
    readFile: (p: string) => files.get(p) ?? new Uint8Array([137, 80, 78, 71]),
    rm: (p: string) => { removed.push(p); files.delete(p); },
    bin: "/fake/clipread",
  };
  return { a: realActions(() => ({ code: 0 }), null, {}, clip), calls, removed };
}

test("clipboard via helper: targets/image/text call the binary, not osascript", () => {
  const { a, calls, removed } = clipHelperFixture();
  expect(a.clipboardTargets()).toEqual(["image/png", "text/plain"]);
  expect(a.clipboardImage()).toEqual(new Uint8Array([137, 80, 78, 71]));
  expect(a.clipboardText()).toBe("helper text");
  expect(calls.every((c) => c[0] === "/fake/clipread")).toBe(true); // no osascript/pbpaste
  expect(calls.find((c) => c[1] === "image")?.[2]).toBe("/tmp/h.png"); // the helper gets the target path
  expect(removed).toEqual(["/tmp/h.png"]); // temp removed after reading
});

test("clipboard via helper: empty clipboard (exit 1) → [], null, null", () => {
  const { a, removed } = clipHelperFixture({ targets: { code: 1, stdout: "" }, text: { code: 1, stdout: "" }, image: 1 });
  expect(a.clipboardTargets()).toEqual([]);
  expect(a.clipboardImage()).toBeNull();
  expect(a.clipboardText()).toBeNull();
  expect(removed).toEqual(["/tmp/h.png"]); // failure cleans up the temp too
});

test("clipboardTargets maps clipboard info to MIME types", () => {
  const { a } = clipFixture({ info: { code: 0, stdout: "«class PNGf», 143360, «class 8BPS», 2, string, 12" } });
  expect(a.clipboardTargets()).toEqual(["image/png", "text/plain"]);
  const textOnly = clipFixture({ info: { code: 0, stdout: "string, 44, «class utf8», 44" } });
  expect(textOnly.a.clipboardTargets()).toEqual(["text/plain"]);
  const nic = clipFixture({ info: { code: 1, stdout: "" } });
  expect(nic.a.clipboardTargets()).toEqual([]);
});

test("clipboardImage writes the PNG via osascript, reads it and removes the temp file", () => {
  const { a, removed } = clipFixture();
  expect(a.clipboardImage()).toEqual(new Uint8Array([137, 80, 78, 71]));
  expect(removed).toEqual(["/tmp/clip-test.png"]); // success removes the temp
  const fail = clipFixture({ png: 1 }); // coercion failed = no image
  expect(fail.a.clipboardImage()).toBeNull();
  expect(fail.removed).toEqual(["/tmp/clip-test.png"]); // failure removes the temp too
});

test("clipboardImage: empty file → null (the temp is still removed)", () => {
  const { a, removed } = clipFixture({ readFile: () => new Uint8Array() });
  expect(a.clipboardImage()).toBeNull();
  expect(removed).toEqual(["/tmp/clip-test.png"]);
});

test("clipboardText returns pbpaste output, empty → null", () => {
  const { a } = clipFixture({ pb: { code: 0, stdout: "clipboard text" } });
  expect(a.clipboardText()).toBe("clipboard text");
  expect(clipFixture({ pb: { code: 0, stdout: "" } }).a.clipboardText()).toBeNull();
  expect(clipFixture({ pb: { code: 1, stdout: "" } }).a.clipboardText()).toBeNull();
});

test("clipboardPngScript writes to the given path and closes the file on error", () => {
  const s = clipboardPngScript("/tmp/x.png");
  expect(s).toContain('POSIX file "/tmp/x.png"');
  expect(s).toContain("«class PNGf»");
  expect(s).toContain("on error");
});

// Helper stub for files: cmd = [bin, "file", outpath, maxBytes]
function clipFileFixture(over: Partial<{ code: number; name: string; bytes: Uint8Array }> = {}) {
  const bytes = over.bytes ?? new Uint8Array([1, 2, 3, 4]);
  const removed: string[] = [];
  const a = realActions(
    () => ({ code: 0 }),
    null,
    {},
    {
      bin: "/fake/clipread",
      out: (...cmd: string[]) => {
        if (cmd[1] === "file") return { code: over.code ?? 0, stdout: over.name ?? "invoice.pdf" };
        return { code: 1, stdout: "" };
      },
      readFile: () => bytes,
      rm: (p: string) => removed.push(p),
      tmpFile: () => "/tmp/clipfile",
    },
  );
  return { a, removed };
}

test("clipboardFile: the helper returns name + bytes; the temp is cleaned up", () => {
  const { a, removed } = clipFileFixture({ name: "invoice.pdf", bytes: new Uint8Array([9, 9]) });
  expect(a.clipboardFile()).toEqual({ name: "invoice.pdf", bytes: new Uint8Array([9, 9]) });
  expect(removed).toContain("/tmp/clipfile");
});

test("clipboardFile: no file (exit 1) → null, over the cap (exit 4) → {tooBig}", () => {
  expect(clipFileFixture({ code: 1 }).a.clipboardFile()).toBeNull();
  expect(clipFileFixture({ code: 4 }).a.clipboardFile()).toEqual({ tooBig: true });
});

test("clipboardFile: no helper (osascript fallback) → null", () => {
  const a = realActions(() => ({ code: 0 }), null, {}, { bin: null });
  expect(a.clipboardFile()).toBeNull();
});

test("MAX_FILE_BYTES is 25 MB", () => {
  expect(MAX_FILE_BYTES).toBe(25 * 1024 * 1024);
});
