import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "..", "infra", "devbox-paste");

// Fake pbcopy/osascript in PATH — the test must not touch the real clipboard or flash a notification.
function fakeBin() {
  const dir = mkdtempSync(join(tmpdir(), "devbox-paste-bin-"));
  writeFileSync(join(dir, "pbcopy"), `#!/bin/sh\ncat > "${join(dir, "clipboard.txt")}"\n`);
  writeFileSync(join(dir, "osascript"), `#!/bin/sh\necho "$@" >> "${join(dir, "notify.txt")}"\n`);
  chmodSync(join(dir, "pbcopy"), 0o755);
  chmodSync(join(dir, "osascript"), 0o755);
  return dir;
}

async function run(bin: string, env: Record<string, string>) {
  const p = Bun.spawn(["sh", SCRIPT], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...env },
    stdout: "pipe",
    stderr: "ignore",
  });
  const code = await p.exited;
  const stdout = await new Response(p.stdout).text();
  return { code, stdout };
}

test("devbox-paste: 200 → prints the path to stdout and puts it on the clipboard", async () => {
  const bin = fakeBin();
  const srv = Bun.serve({
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === "/api/clipboard/file" && u.searchParams.get("target") === "shared") {
        return new Response("/inbox/invoice.pdf");
      }
      return new Response(null, { status: 404 });
    },
  });
  try {
    const r = await run(bin, { DEVD_URL: `http://localhost:${srv.port}` });
    expect(r.code).toBe(0);
    // stdout is the contract for Hammerspoon: it types the path character by character, does not rely on ⌘V
    expect(r.stdout).toBe("/inbox/invoice.pdf");
    // we still fill the clipboard — a manual ⌘V remains as a fallback
    expect(readFileSync(join(bin, "clipboard.txt"), "utf8")).toBe("/inbox/invoice.pdf");
    expect(existsSync(join(bin, "notify.txt"))).toBe(false);
  } finally { srv.stop(true); }
});

test("devbox-paste: 204 (no file on the clipboard) → exit 1, nothing on stdout, notification", async () => {
  const bin = fakeBin();
  const srv = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 204 }) });
  try {
    const r = await run(bin, { DEVD_URL: `http://localhost:${srv.port}` });
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(readFileSync(join(bin, "notify.txt"), "utf8")).toContain("No file"); // notification text from infra/devbox-paste
  } finally { srv.stop(true); }
});

test("devbox-paste: 413 → exit 1 with a size message; 500 → exit 2", async () => {
  const big = fakeBin();
  const s1 = Bun.serve({ port: 0, fetch: () => new Response("too big", { status: 413 }) });
  try {
    const r = await run(big, { DEVD_URL: `http://localhost:${s1.port}` });
    expect(r.code).toBe(1);
    expect(readFileSync(join(big, "notify.txt"), "utf8")).toContain("too large"); // notification text from infra/devbox-paste
  } finally { s1.stop(true); }

  const err = fakeBin();
  const s2 = Bun.serve({ port: 0, fetch: () => new Response("error", { status: 500 }) });
  try {
    expect((await run(err, { DEVD_URL: `http://localhost:${s2.port}` })).code).toBe(2);
  } finally { s2.stop(true); }
});
