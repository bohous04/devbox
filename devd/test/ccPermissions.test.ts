import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dirs: string[] = [];
afterEach(() => { for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true }); });

test("cc passes the requested bypass environment through exec and preserves exact resume arguments", () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-permissions-")); dirs.push(dir);
  const cli = join(dir, "claude");
  writeFileSync(cli, '#!/usr/bin/env bash\nprintf "%s\\n" "$CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS" "$@"\n');
  chmodSync(cli, 0o755);
  for (const override of [undefined, "0"]) {
    const env: Record<string, string | undefined> = { ...process.env, PATH: `${dir}:${process.env.PATH}`, DEVD_SESSION_ID: "dev-fixture", DEVBOX_PROXY_PROFILE: "", TMUX_PANE: "" };
    delete env.CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS;
    if (override !== undefined) env.CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS = override;
    const p = Bun.spawnSync(["bash", join(import.meta.dir, "../../image/cc"), "--resume", "11111111-1111-1111-1111-111111111111"], { env });
    expect(p.exitCode).toBe(0);
    expect(p.stdout.toString().trim().split("\n")).toEqual([override ?? "1", "--dangerously-skip-permissions", "--remote-control", "dev-fixture", "--resume", "11111111-1111-1111-1111-111111111111"]);
  }
});
