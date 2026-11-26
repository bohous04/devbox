import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "..", "image", "devbox-tmux-status");
const REAL_GIT = Bun.which("git");
// The helper is written for the Linux image; macOS has neither flock nor timeout.
const t = Bun.which("flock") && Bun.which("timeout") && REAL_GIT ? test : test.skip;

type Fixture = { ws: string; cache: string; log: string; env: Record<string, string> };

// A repo plus a `git` shim on PATH that logs every `status` call (and can make it fail).
function fixture(opts: { failStatus?: boolean } = {}): Fixture {
  const ws = mkdtempSync(join(tmpdir(), "tmux-status-ws-"));
  const aux = mkdtempSync(join(tmpdir(), "tmux-status-aux-"));
  const init = Bun.spawnSync(["sh", "-c", "git init -q -b main && git -c user.name=t -c user.email=t@t commit -q --allow-empty -m init"], { cwd: ws });
  if (init.exitCode !== 0) throw new Error(init.stderr.toString());
  const log = join(aux, "status-calls");
  writeFileSync(log, "");
  writeFileSync(join(aux, "git"), `#!/bin/sh
case " $* " in *" status "*) echo run >> "${log}"; ${opts.failStatus ? "exit 1" : ":"} ;; esac
exec "${REAL_GIT}" "$@"
`);
  chmodSync(join(aux, "git"), 0o755);
  const cache = join(aux, "cache");
  return {
    ws, cache, log,
    env: { ...process.env, PATH: `${aux}:${process.env.PATH}`, DEVBOX_STATUS_WORKSPACE: ws, DEVBOX_STATUS_CACHE: cache },
  };
}

async function status(f: Fixture): Promise<string> {
  const p = Bun.spawn(["sh", SCRIPT], { env: f.env, stdout: "pipe", stderr: "ignore" });
  const out = await new Response(p.stdout).text();
  await p.exited;
  return out;
}

const statusRuns = (f: Fixture) => readFileSync(f.log, "utf8").split("\n").filter(Boolean).length;

async function cacheWritten(f: Fixture): Promise<string> {
  for (let i = 0; i < 60; i++) {
    if (existsSync(f.cache)) return readFileSync(f.cache, "utf8").trim();
    await Bun.sleep(50);
  }
  throw new Error("background refresh never wrote the cache");
}

t("tmux-status: first call prints the branch at once, the count follows from the cache", async () => {
  const f = fixture();
  writeFileSync(join(f.ws, "a.txt"), "x");
  writeFileSync(join(f.ws, "b.txt"), "x");
  expect(await status(f)).toBe("⎇ main · ");
  expect(await cacheWritten(f)).toBe("2");
  expect(await status(f)).toBe("⎇ main ±2 · ");
});

t("tmux-status: concurrent and repeated redraws run git status once", async () => {
  const f = fixture();
  await Promise.all(Array.from({ length: 10 }, () => status(f)));
  await cacheWritten(f);
  for (let i = 0; i < 5; i++) await status(f);
  await Bun.sleep(300);
  expect(statusRuns(f)).toBe(1);
});

t("tmux-status: a failing git status is not retried on the next redraw", async () => {
  const f = fixture({ failStatus: true });
  expect(await status(f)).toBe("⎇ main · ");
  expect(await cacheWritten(f)).toBe("");
  for (let i = 0; i < 5; i++) expect(await status(f)).toBe("⎇ main · ");
  await Bun.sleep(300);
  expect(statusRuns(f)).toBe(1);
});

t("tmux-status: a damaged cache is ignored, not rendered", async () => {
  const f = fixture();
  writeFileSync(f.cache, "garbage; rm -rf\n");
  expect(await status(f)).toBe("⎇ main · ");
});

t("tmux-status: outside a git repo it prints nothing", async () => {
  const f = fixture();
  const plain = mkdtempSync(join(tmpdir(), "tmux-status-plain-"));
  f.env.DEVBOX_STATUS_WORKSPACE = plain;
  expect(await status(f)).toBe("");
  expect(statusRuns(f)).toBe(0);
});
