import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LAUNCHER = join(import.meta.dir, "..", "..", "image", "lua-language-server");
const t = Bun.which("jq") ? test : test.skip;   // the launcher builds the config with jq

// Runs the launcher in a workspace holding `luarc` (undefined = no .luarc.json) with a stand-in
// server that prints its arguments; returns the config the server was pointed at.
async function launch(luarc?: string): Promise<{ code: number; args: string[]; config: Record<string, unknown> | null }> {
  const ws = mkdtempSync(join(tmpdir(), "luals-ws-"));
  const aux = mkdtempSync(join(tmpdir(), "luals-aux-"));
  if (luarc !== undefined) writeFileSync(join(ws, ".luarc.json"), luarc);
  const bin = join(aux, "server");
  writeFileSync(bin, '#!/bin/sh\nprintf "%s\\n" "$@"\n');
  chmodSync(bin, 0o755);
  const p = Bun.spawn(["sh", LAUNCHER, "--stdio"], {
    cwd: ws, stdout: "pipe", stderr: "ignore",
    env: { ...process.env, XDG_CACHE_HOME: join(aux, "cache"), DEVBOX_LUALS_BIN: bin },
  });
  const args = (await new Response(p.stdout).text()).split("\n").filter(Boolean);
  const code = await p.exited;
  const path = args.find((a) => a.startsWith("--configpath="))?.slice("--configpath=".length);
  return { code, args, config: path ? JSON.parse(readFileSync(path, "utf8")) : null };
}

t("lua-language-server: adds .worktrees to the repo's prefixed ignoreDir and keeps the rest", async () => {
  const r = await launch(JSON.stringify({ "Lua.runtime.version": "Lua 5.4", "Lua.workspace.ignoreDir": ["rawData", "**/dist"] }));
  expect(r.code).toBe(0);
  expect(r.config).toEqual({ "Lua.runtime.version": "Lua 5.4", "Lua.workspace.ignoreDir": ["rawData", "**/dist", ".worktrees"] });
  expect(r.args.at(-1)).toBe("--stdio");
  expect(r.args.some((a) => a.startsWith("--logpath="))).toBe(true);
});

t("lua-language-server: handles the unprefixed key", async () => {
  const r = await launch(JSON.stringify({ "workspace.ignoreDir": ["docs"] }));
  expect(r.config).toEqual({ "workspace.ignoreDir": ["docs", ".worktrees"] });
});

t("lua-language-server: a config without ignoreDir keeps LuaLS's default next to .worktrees", async () => {
  const r = await launch(JSON.stringify({ "runtime.version": "Lua 5.4" }));
  expect(r.config).toEqual({ "runtime.version": "Lua 5.4", "workspace.ignoreDir": [".vscode", ".worktrees"] });
});

t("lua-language-server: a workspace without .luarc.json still ignores .worktrees", async () => {
  const r = await launch();
  expect(r.code).toBe(0);
  expect(r.config).toEqual({ "workspace.ignoreDir": [".vscode", ".worktrees"] });
});

t("lua-language-server: does not add .worktrees twice", async () => {
  const r = await launch(JSON.stringify({ "workspace.ignoreDir": [".worktrees", "docs"] }));
  expect(r.config).toEqual({ "workspace.ignoreDir": [".worktrees", "docs"] });
});

// Starting anyway would index every worktree again, so each of these must stop the launch.
for (const [what, luarc] of [
  ["invalid JSON", "{ not json"],
  ["a nested ignoreDir", JSON.stringify({ workspace: { ignoreDir: ["docs"] } })],
  ["an ignoreDir that is not an array", JSON.stringify({ "workspace.ignoreDir": "docs.worktrees" })],
  ["a top level that is not an object", "[]"],
] as const) {
  t(`lua-language-server: ${what} stops the launch`, async () => {
    const r = await launch(luarc);
    expect(r.code).toBe(1);
    expect(r.args).toEqual([]);
  });
}
