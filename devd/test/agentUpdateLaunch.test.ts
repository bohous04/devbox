import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

async function launch(tool: "co" | "gr" | "cc", args: string[], env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "agent-update-launch-"));
  dirs.push(dir);
  const log = join(dir, "update.log");
  writeFileSync(log, "");
  for (const [name, script] of Object.entries({
    timeout: '#!/bin/sh\nprintf "%s\\n" "$@" >> "$UPDATE_LOG"\nexit "${UPDATE_EXIT:-0}"\n',
    codex: '#!/bin/sh\nprintf "%s\\n" "$@"\n',
    grok: '#!/bin/sh\nprintf "%s\\n" "$@"\n',
    claude: '#!/bin/sh\nprintf "%s\\n" "$@"\n',
    tmux: '#!/bin/sh\nprintf "%s\\n" "$*" >> "$UPDATE_LOG"\nexit "${TMUX_EXIT:-0}"\n',
  })) {
    writeFileSync(join(dir, name), script);
    chmodSync(join(dir, name), 0o755);
  }
  const updater = join(dir, "agent-auto-update");
  writeFileSync(updater, "#!/bin/sh\nexit 0\n");
  chmodSync(updater, 0o755);
  const wrapper = join(dir, tool);
  writeFileSync(wrapper, readFileSync(join(import.meta.dir, "../../image", tool), "utf8")
    .replaceAll("/usr/local/bin/agent-auto-update", updater));
  writeFileSync(join(dir, "codex-account-env.sh"), readFileSync(join(import.meta.dir, "../../image/codex-account-env.sh")));
  const p = Bun.spawn(["bash", wrapper, ...args], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, UPDATE_LOG: log,
      DEVD_AGENT_AUTO_UPDATE: "1", DEVD_SESSION_ID: "", CODEX_HOME: dir, ...env },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const out = await new Response(p.stdout).text();
  const err = await new Response(p.stderr).text();
  return { code: await p.exited, args: out.trim().split("\n"), err, update: readFileSync(log, "utf8").replaceAll(updater, "/usr/local/bin/agent-auto-update") };
}

test("cc: switching to Claude releases only the automatic pane title", async () => {
  for (const code of [0, 1]) {
    const result = await launch("cc", ["--resume", "session with spaces"], {
      TMUX_PANE: "%17", TMUX_EXIT: String(code),
    });
    expect(result.code).toBe(0);
    expect(result.update.split("\n")).toEqual([
      "set-option -pu -t %17 @devd_auto_title",
      "set-option -pu -t %17 @devd_title_session", "",
    ]);
    expect(result.args.slice(-2)).toEqual(["--resume", "session with spaces"]);
  }
  expect((await launch("cc", [], { TMUX_PANE: "" })).update).toBe("");
  for (const arg of ["--help", "-h", "--version", "-v"]) {
    expect((await launch("cc", [arg], { TMUX_PANE: "%17" })).update).toBe("");
  }
});

for (const [wrapper, tool] of [["co", "codex"], ["gr", "grok"]] as const) {
  test(`${wrapper}: bounded update precedes launch, arguments remain intact`, async () => {
    const result = await launch(wrapper, ["resume", "session with spaces", "--last"]);
    expect(result.code).toBe(0);
    expect(result.update.split("\n")).toEqual(["-k", "2s", "45s", "/usr/local/bin/agent-auto-update", tool, ""]);
    expect(result.args.slice(-3)).toEqual(["resume", "session with spaces", "--last"]);
    expect(result.args).toContain(wrapper === "co" ? "check_for_update_on_startup=false" : "--no-auto-update");
  });

  test(`${wrapper}: timeout or unavailable updater still starts the installed agent`, async () => {
    for (const code of [1, 124, 127]) {
      const result = await launch(wrapper, ["test prompt"], { UPDATE_EXIT: String(code) });
      expect(result.code).toBe(0);
      expect(result.args.at(-1)).toBe("test prompt");
    }
  });

  test(`${wrapper}: help/version and explicit opt-out do not access the updater`, async () => {
    for (const arg of ["--help", "--version"]) expect((await launch(wrapper, [arg])).update).toBe("");
    expect((await launch(wrapper, ["test prompt"], { DEVD_AGENT_AUTO_UPDATE: "0" })).update).toBe("");
  });
}
