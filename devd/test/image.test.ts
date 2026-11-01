import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sh } from "./helpers/sh";
import { hasDocker } from "./helpers/docker";

const enabled = process.env.DEVD_IMAGE_TESTS === "1" && hasDocker;
const NAME = "devbox-image-test";

test.skipIf(!enabled)("image builds, toolchain present, entrypoint consumes prompt file", async () => {
  const build = sh(join(import.meta.dir, "..", ".."), "docker", "build", "-t", "devbox:test", "image");
  if (build.code !== 0) throw new Error(`docker build failed:\n${build.stderr.slice(-3000)}`);

  // typescript-language-server and serena run here as `dev` (no --user, the container
  // starts as USER dev — see id -un/id -u below), not as root: exactly the path through
  // which a missing chmod or one of the UV_ variables would silently slip (serena would
  // then start for root but crash for dev with "Permission denied"). A text-level
  // check of the Dockerfile cannot see this class of bug.
  const tools = sh(process.cwd(), "docker", "run", "--rm", "devbox:test", "bash", "-lc",
    "node --version && bun --version && pnpm --version && gh --version && rg --version && glow --version && tmux -V && uv --version && jq --version && claude --version && typescript-language-server --version && serena start-mcp-server --help && id -un && id -u");
  expect(tools.code).toBe(0);
  expect(tools.stdout).toMatch(/^v22\./m); // NodeSource repo actually landed, not Ubuntu's nodejs
  const lines = tools.stdout.trim().split("\n");
  expect(lines.at(-2)).toBe("dev");
  expect(lines.at(-1)).toBe("1000");

  const shims = sh(process.cwd(), "docker", "run", "--rm", "devbox:test", "bash", "-lc",
    "test -x /usr/local/bin/cc && test -x /usr/local/bin/co && test -x /usr/local/bin/agent-launch && codex --version");
  expect(shims.code).toBe(0);

  // The bridge for MCP `xcode` (mac-mcp-bridge/) and its preflight (mac-sync) must be in the image
  // and executable; test_*.py must not — this is the only check that .dockerignore
  // actually works (the Dockerfile itself does not copy tests, but without dockerignore
  // COPY mac-mcp-bridge would pick them up).
  const macMcp = sh(process.cwd(), "docker", "run", "--rm", "devbox:test", "bash", "-lc",
    "test -x /opt/mac-mcp-bridge/bridge.py && test -x /usr/local/bin/mac-sync && ! test -e /opt/mac-mcp-bridge/test_bridge.py");
  expect(macMcp.code).toBe(0);

  const ws = mkdtempSync(join(tmpdir(), "img-ws-"));
  const ctl = mkdtempSync(join(tmpdir(), "img-ctl-"));
  writeFileSync(join(ctl, "prompt"), "Test prompt from devd");
  // mkdtemp dirs are 0700 owned by the host UID; container's dev (uid 1000) must
  // read + delete the prompt — mirror syncPromptFile's production safeguard.
  chmodSync(ctl, 0o777);
  chmodSync(join(ctl, "prompt"), 0o666);
  sh(process.cwd(), "docker", "rm", "-f", NAME);
  const run = sh(process.cwd(), "docker", "run", "-d", "--name", NAME,
    "-v", `${ws}:/workspace`, "-v", `${ctl}:/run/devd`, "devbox:test");
  expect(run.code).toBe(0);
  await new Promise((r) => setTimeout(r, 10_000));
  expect(sh(process.cwd(), "docker", "exec", NAME, "tmux", "has-session", "-t", "main").code).toBe(0);
  expect(existsSync(join(ctl, "prompt"))).toBe(false); // launcher consumed it
  sh(process.cwd(), "docker", "rm", "-f", NAME);
}, 1_800_000);

test("Dockerfile installs @openai/codex and sets CODEX_HOME", async () => {
  const df = await Bun.file(new URL("../../image/Dockerfile", import.meta.url).pathname).text();
  expect(df).toContain("@openai/codex");
  expect(df).toMatch(/ENV\s+CODEX_HOME=\/home\/dev\/\.codex/);
});

test("Dockerfile installs typescript-language-server (without it the LSP plugin is dead)", async () => {
  const df = await Bun.file(new URL("../../image/Dockerfile", import.meta.url).pathname).text();
  expect(df).toContain("typescript-language-server");
});

test("Dockerfile installs serena with all three UV_ variables", async () => {
  const df = await Bun.file(new URL("../../image/Dockerfile", import.meta.url).pathname).text();
  expect(df).toContain("serena-agent");
  // Each of them is required: without UV_TOOL_BIN_DIR serena is not on PATH, without UV_TOOL_DIR
  // and UV_PYTHON_INSTALL_DIR both the tool and the interpreter point to /root, which uid 1000 cannot see.
  for (const v of ["UV_PYTHON_INSTALL_DIR", "UV_TOOL_DIR", "UV_TOOL_BIN_DIR"]) {
    expect(df).toContain(v);
  }
});

test("Dockerfile installs agy root-owned outside dev's home and copies ag + agy-trust", async () => {
  const df = await Bun.file(new URL("../../image/Dockerfile", import.meta.url).pathname).text();
  expect(df).toContain("https://antigravity.google/cli/install.sh");
  expect(df).toMatch(/HOME=\/opt\/agy/);
  expect(df).toMatch(/su -s \/bin\/sh -c 'agy --version' nobody/);
  expect(df).toMatch(/COPY ag \/usr\/local\/bin\/ag/);
  expect(df).toMatch(/COPY agy-trust \/usr\/local\/bin\/agy-trust/);
  // a new named volume takes its owner from the image — without this it ends up root:root (EACCES)
  expect(df).toMatch(/install -d -o dev -g dev [^\n]*\/home\/dev\/\.gemini/);
  expect(df).toMatch(/COPY seed-agy-hooks\.sh \/usr\/local\/bin\/seed-agy-hooks/);
});

test("entrypoint seeds agy hooks", async () => {
  const ep = await Bun.file(new URL("../../image/entrypoint.sh", import.meta.url).pathname).text();
  expect(ep).toContain("seed-agy-hooks || true");
});
