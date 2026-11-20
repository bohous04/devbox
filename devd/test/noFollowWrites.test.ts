// devd runs as root and writes into directories the session's agent can write into (the control dir
// mounted as /run/devd, the workspace, the bare clone). A symlink the agent plants there must never
// make devd write, chmod or chown the link's target.
import { afterAll, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config";
import { openDb } from "../src/db";
import { lockWorktree, reregisterWorktree } from "../src/git";
import { ensureInbox, stageFile } from "../src/inbox";
import { openDirNoFollow, writeFileAt } from "../src/noFollowFs";
import { SessionManager } from "../src/sessions";

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

/** A host file the agent would like devd to overwrite: content and mode must stay. */
function sentinel(): { path: string; dir: string; intact: () => void } {
  const dir = tmp("nofollow-host-");
  const path = join(dir, "secret");
  writeFileSync(path, "HOST-HARBOR\n", { mode: 0o600 });
  return {
    path, dir,
    intact: () => {
      expect(readFileSync(path, "utf8")).toBe("HOST-HARBOR\n");
      expect(statSync(path).mode & 0o777).toBe(0o600);
    },
  };
}

function manager(extra: Record<string, unknown> = {}) {
  const root = tmp("nofollow-root-");
  const ctl = join(root, "ctl");
  const mgr = new SessionManager({ db: openDb(":memory:"), cfg: DEFAULT_CONFIG, root, image: "alpine:3", controlRoot: ctl, ...extra } as never);
  return { mgr: mgr as unknown as Record<string, (...a: unknown[]) => unknown>, ctl };
}

test("prompt file: a planted symlink is replaced, its target untouched (conflict and scheduled override)", () => {
  const { mgr, ctl } = manager();
  const s = sentinel();
  const id = "dev-harbor-api";
  mkdirSync(join(ctl, id), { recursive: true });
  for (const [pull, override] of [[{ status: "conflict", files: ["a.ts"] }, undefined], [{ status: "clean" }, "nightly run"]] as const) {
    rmSync(join(ctl, id, "prompt"), { force: true });
    symlinkSync(s.path, join(ctl, id, "prompt"));
    const prompt = mgr.syncPromptFile!.call(mgr, id, "tmux", pull, override) as string;
    s.intact();
    const st = lstatSync(join(ctl, id, "prompt"));
    expect(st.isFile()).toBe(true);
    expect(st.mode & 0o777).toBe(0o666);
    expect(readFileSync(join(ctl, id, "prompt"), "utf8")).toBe(prompt);
  }
});

test("gitea placeholder tokens: a planted symlink is replaced, its target untouched", () => {
  const { mgr, ctl } = manager({ issuePlaceholder: (sid: string) => `ph-${sid}`, giteaInstances: () => [{ name: "infra", url: "https://git.example/" }] });
  const s = sentinel();
  const id = "dev-harbor-api";
  mkdirSync(join(ctl, id), { recursive: true });
  symlinkSync(s.path, join(ctl, id, "gitea-tokens.json"));
  const path = mgr.gitTokensFor!.call(mgr, id) as string;
  s.intact();
  expect(path).toBe(join(ctl, id, "gitea-tokens.json"));
  expect(lstatSync(path).isFile()).toBe(true);
  expect(JSON.parse(readFileSync(path, "utf8"))).toBeTruthy();
});

test("manual-stop marker: a symlinked recovery dir is replaced by a real one, a symlinked marker too", () => {
  const { mgr, ctl } = manager();
  const s = sentinel();
  const id = "dev-harbor-api";
  mkdirSync(join(ctl, id), { recursive: true });
  symlinkSync(s.dir, join(ctl, id, "recovery"));
  mgr.markManualStop!.call(mgr, id);
  expect(existsSync(join(s.dir, "manual-stop"))).toBe(false);
  expect(statSync(s.dir).mode & 0o777).toBe(0o700);
  expect(lstatSync(join(ctl, id, "recovery")).isDirectory()).toBe(true);
  expect(readFileSync(join(ctl, id, "recovery", "manual-stop"), "utf8")).toBe("1\n");
  s.intact();

  rmSync(join(ctl, id, "recovery", "manual-stop"));
  symlinkSync(s.path, join(ctl, id, "recovery", "manual-stop"));
  mgr.markManualStop!.call(mgr, id);
  s.intact();
  expect(readFileSync(join(ctl, id, "recovery", "manual-stop"), "utf8")).toBe("1\n");
});

test("inbox: a symlinked .inbox is refused; a symlinked exclude file or info dir is left alone", () => {
  const s = sentinel();
  const ws = tmp("nofollow-ws-");
  symlinkSync(s.dir, join(ws, ".inbox"));
  expect(() => stageFile(ws, "data.bin", new Uint8Array([1]))).toThrow();
  expect(existsSync(join(s.dir, "data.bin"))).toBe(false);

  const ws2 = tmp("nofollow-ws-");
  mkdirSync(join(ws2, ".git", "info"), { recursive: true });
  symlinkSync(s.path, join(ws2, ".git", "info", "exclude"));
  ensureInbox(ws2);
  s.intact();

  const ws3 = tmp("nofollow-ws-");
  mkdirSync(join(ws3, ".git"));
  symlinkSync(s.dir, join(ws3, ".git", "info"));
  writeFileSync(join(s.dir, "exclude"), "keep\n", { mode: 0o600 });
  ensureInbox(ws3);
  expect(readFileSync(join(s.dir, "exclude"), "utf8")).toBe("keep\n");
});

test("worktree lock marker: a dangling symlink or a symlinked registration dir is not followed", () => {
  const s = sentinel();
  const bare = tmp("nofollow-bare-");
  mkdirSync(join(bare, "worktrees", "harbor-1"), { recursive: true });
  const target = join(s.dir, "created-by-root");
  symlinkSync(target, join(bare, "worktrees", "harbor-1", "locked"));
  lockWorktree(bare, "/srv/x/harbor-1");
  expect(existsSync(target)).toBe(false);

  rmSync(join(bare, "worktrees", "harbor-2"), { recursive: true, force: true });
  symlinkSync(s.dir, join(bare, "worktrees", "harbor-2"));
  lockWorktree(bare, "/srv/x/harbor-2");
  expect(existsSync(join(s.dir, "locked"))).toBe(false);
});

test("worktree re-registration: a symlinked .git or registration file is replaced, the target untouched", async () => {
  const s = sentinel();
  const bare = tmp("nofollow-bare-");
  const dest = join(tmp("nofollow-wt-"), "harbor-1");
  mkdirSync(dest);
  symlinkSync(s.path, join(dest, ".git"));
  mkdirSync(join(bare, "worktrees", "harbor-1"), { recursive: true });
  symlinkSync(s.path, join(bare, "worktrees", "harbor-1", "HEAD"));
  await reregisterWorktree(bare, dest, "ref: refs/heads/main");
  s.intact();
  expect(readFileSync(join(dest, ".git"), "utf8")).toBe(`gitdir: ${join(bare, "worktrees", "harbor-1")}\n`);
});

test("openDirNoFollow refuses a symlink at any level; writeFileAt never follows the final name", () => {
  const s = sentinel();
  const root = tmp("nofollow-dir-");
  mkdirSync(join(root, "a"));
  symlinkSync(s.dir, join(root, "a", "b"));
  expect(() => openDirNoFollow(root, ["a", "b"])).toThrow();
  expect(() => openDirNoFollow(root, ["a", "b", "c"], true)).toThrow();
  const d = openDirNoFollow(root, ["a"]);
  try {
    symlinkSync(s.path, join(root, "a", "f"));
    expect(() => writeFileAt(d, "f", "x", { mode: 0o644 })).toThrow();
    writeFileAt(d, "f", "x", { mode: 0o644, replace: true });
  } finally { d.close(); }
  s.intact();
  expect(readFileSync(join(root, "a", "f"), "utf8")).toBe("x");
});
