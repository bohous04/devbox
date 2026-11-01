import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agyMcpCommands, BUILTIN_MARKETPLACES, BUILTIN_PLUGINS, buildAgySyncCommands, buildCodexSyncCommands, buildGrokSyncCommands, buildPruneCommands, grokCannotInstall, buildSetupFromMacState, buildSyncCommands, codexMcpCommands, describeCommand, desiredMcpNames, grokMcpCommands, isSecretBearingCommand, parseAgyMcpNames, parseClaudeMcpNames, parseTomlMcpNames } from "../src/claudeSetup";

const known = {
  "infra-marketplace": { source: { source: "git", url: "https://github.com/acme/infra-marketplace.git" } },
  "claude-plugins-official": { source: { source: "github", repo: "anthropics/claude-plugins-official" } },
};
const installed = {
  version: 2,
  plugins: {
    "superpowers@claude-plugins-official": [{ scope: "user" }],
    "core@acme-skills": [{ scope: "user" }],
  },
};

test("buildSetupFromMacState maps sources and sorts", () => {
  const s = buildSetupFromMacState(known, installed);
  expect(s.marketplaces).toEqual([
    { name: "claude-plugins-official", source: "anthropics/claude-plugins-official" },
    { name: "infra-marketplace", source: "https://github.com/acme/infra-marketplace.git" },
  ]);
  expect(s.plugins).toEqual(["core@acme-skills", "superpowers@claude-plugins-official"]);
});

test("buildSyncCommands emits marketplace adds, installs, then mcp add-json (incl. built-ins)", () => {
  const s = buildSetupFromMacState(known, installed);
  const cmds = buildSyncCommands(s, { context7: { type: "http", url: "https://mcp.context7.com" } });
  expect(cmds).toEqual([
    ["claude", "plugin", "marketplace", "add", "JuliusBrussee/caveman"],
    ["claude", "plugin", "marketplace", "add", "anthropics/claude-plugins-official"],
    ["claude", "plugin", "marketplace", "add", "https://github.com/acme/infra-marketplace.git"],
    ["claude", "plugin", "install", "caveman@caveman"],
    ["claude", "plugin", "install", "typescript-lsp@claude-plugins-official"],
    ["claude", "plugin", "install", "core@acme-skills"],
    ["claude", "plugin", "install", "superpowers@claude-plugins-official"],
    ["claude", "mcp", "remove", "context7", "-s", "user"],
    ["claude", "mcp", "add-json", "--scope", "user", "context7", '{"type":"http","url":"https://mcp.context7.com"}'],
    ["claude", "mcp", "remove", "playwright", "-s", "user"],
    ["claude", "mcp", "add-json", "--scope", "user", "playwright", '{"command":"sh","args":["-c","if command -v playwright-mcp-devbox >/dev/null 2>&1; then exec playwright-mcp-devbox \\"$@\\"; else exec playwright-mcp --headless \\"$@\\"; fi","playwright-mcp","--browser","chromium","--no-sandbox"]}'],
    ["claude", "mcp", "remove", "serena", "-s", "user"],
    ["claude", "mcp", "add-json", "--scope", "user", "serena", '{"command":"serena","args":["start-mcp-server","--context","ide"]}'],
  ]);
});

test("an empty setup still registers built-in marketplaces, plugins and MCP servers", () => {
  const s = buildSetupFromMacState(undefined, undefined);
  expect(s).toEqual({ marketplaces: [], plugins: [] });
  expect(buildSyncCommands(s)).toEqual([
    ["claude", "plugin", "marketplace", "add", "JuliusBrussee/caveman"],
    ["claude", "plugin", "marketplace", "add", "anthropics/claude-plugins-official"],
    ["claude", "plugin", "install", "caveman@caveman"],
    ["claude", "plugin", "install", "typescript-lsp@claude-plugins-official"],
    ["claude", "mcp", "remove", "playwright", "-s", "user"],
    ["claude", "mcp", "add-json", "--scope", "user", "playwright", '{"command":"sh","args":["-c","if command -v playwright-mcp-devbox >/dev/null 2>&1; then exec playwright-mcp-devbox \\"$@\\"; else exec playwright-mcp --headless \\"$@\\"; fi","playwright-mcp","--browser","chromium","--no-sandbox"]}'],
    ["claude", "mcp", "remove", "serena", "-s", "user"],
    ["claude", "mcp", "add-json", "--scope", "user", "serena", '{"command":"serena","args":["start-mcp-server","--context","ide"]}'],
  ]);
});

test("marketplace entry without source object is dropped, not thrown", () => {
  const s = buildSetupFromMacState(
    { broken: {}, "claude-plugins-official": { source: { source: "github", repo: "anthropics/claude-plugins-official" } } },
    undefined,
  );
  expect(s.marketplaces).toEqual([
    { name: "claude-plugins-official", source: "anthropics/claude-plugins-official" },
  ]);
});

test("generator CLI tolerates absent plugin state", () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-empty-"));
  const out = join(dir, "claude-setup.json");
  const r = Bun.spawnSync(["bun", "tools/generate-claude-setup.ts", out, join(dir, "mcp.json")], {
    cwd: join(import.meta.dir, "..", ".."),
    env: { ...process.env, CLAUDE_DIR: dir, CLAUDE_JSON: join(dir, "nope.json") },
  });
  expect(r.exitCode).toBe(0);
  expect(JSON.parse(readFileSync(out, "utf8"))).toEqual({ marketplaces: [], plugins: [] });
});

test("built-in playwright MCP has the right flags, no @latest, and a fallback to the old binary", () => {
  const s = buildSetupFromMacState(undefined, undefined);
  const json = buildSyncCommands(s).find((c) => c[5] === "playwright")?.[6] ?? "";
  const def = JSON.parse(json) as { command: string; args: string[] };
  // `sh -c` with a fallback, not the binary directly: an older VPS image without the wrapper in PATH
  // must not stop working after agent-sync (see the BUILTIN_MCP comment in claudeSetup.ts).
  expect(def.command).toBe("sh");
  expect(json).not.toContain("@latest");
  expect(json).not.toContain("npx");
  expect(def.args[0]).toBe("-c");
  expect(def.args[1]).toContain("command -v playwright-mcp-devbox");
  expect(def.args[1]).toContain("exec playwright-mcp-devbox \"$@\"");
  expect(def.args[1]).toContain("exec playwright-mcp --headless \"$@\"");
  expect(def.args.slice(2)).toEqual(["playwright-mcp", "--browser", "chromium", "--no-sandbox"]);
  // `env_vars` is a Codex-specific field (see CODEX_MCP_FIELDS) — Claude must never
  // get it in add-json, otherwise `claude mcp add-json` would get an unknown key.
  expect(json).not.toContain("env_vars");
});

test("a secret MCP named playwright overrides the built-in", () => {
  const s = buildSetupFromMacState(undefined, undefined);
  const cmds = buildSyncCommands(s, { playwright: { type: "http", url: "https://example.test" } });
  expect(cmds).toEqual([
    ["claude", "plugin", "marketplace", "add", "JuliusBrussee/caveman"],
    ["claude", "plugin", "marketplace", "add", "anthropics/claude-plugins-official"],
    ["claude", "plugin", "install", "caveman@caveman"],
    ["claude", "plugin", "install", "typescript-lsp@claude-plugins-official"],
    ["claude", "mcp", "remove", "playwright", "-s", "user"],
    ["claude", "mcp", "add-json", "--scope", "user", "playwright", '{"type":"http","url":"https://example.test"}'],
    ["claude", "mcp", "remove", "serena", "-s", "user"],
    ["claude", "mcp", "add-json", "--scope", "user", "serena", '{"command":"serena","args":["start-mcp-server","--context","ide"]}'],
  ]);
});

test("codexMcpCommands: stdio server → remove + add with env and arguments", () => {
  expect(codexMcpCommands("infra-docs", { command: "node", args: ["/opt/infra-docs-mcp/index.js"], env: { INFRA_DOCS_TOKEN: "t0ken" } })).toEqual([
    ["codex", "mcp", "remove", "infra-docs"],
    ["codex", "mcp", "add", "infra-docs", "--env", "INFRA_DOCS_TOKEN=t0ken", "--", "node", "/opt/infra-docs-mcp/index.js"],
  ]);
});

test("codexMcpCommands: http server with headers → whole block into config.toml, WITHOUT `codex mcp add`", () => {
  const cmds = codexMcpCommands("time-tracking", {
    type: "http", url: "https://tracker.acme.example/api/mcp",
    headers: { Authorization: "Bearer abc", "CF-Access-Client-Id": "cid" },
  })!;
  expect(cmds[0]).toEqual(["codex", "mcp", "remove", "time-tracking"]);
  // `codex mcp add --url` contacts the server when adding it, but the headers would be appended only
  // afterwards — the request would go unauthorized and Codex falls into OAuth, which it has no way to finish
  // in a one-shot container. That is why `add` must NOT appear for servers with headers.
  expect(cmds.some((c) => c[0] === "codex" && c[1] === "mcp" && c[2] === "add")).toBe(false);
  expect(cmds[1][0]).toBe("bash");
  expect(cmds[1][2]).toContain("[mcp_servers.time-tracking]");
  expect(cmds[1][2]).toContain('url = "https://tracker.acme.example/api/mcp"');
  expect(cmds[1][2]).toContain("[mcp_servers.time-tracking.http_headers]");
  expect(cmds[1][2]).toContain('Authorization = "Bearer abc"');
  expect(cmds[1][2]).toContain('"CF-Access-Client-Id" = "cid"');   // a key with a dash must be quoted
  expect(cmds[1][2]).toContain("config.toml");
});

test("codexMcpCommands: http server WITHOUT headers → still `codex mcp add --url`", () => {
  // Without headers the probe on add is harmless (the server is public), so it sticks to the
  // official path and config.toml is not touched by hand.
  expect(codexMcpCommands("public", { type: "http", url: "https://example.com/mcp" })).toEqual([
    ["codex", "mcp", "remove", "public"],
    ["codex", "mcp", "add", "public", "--url", "https://example.com/mcp"],
  ]);
});

test("codexMcpCommands: nonsensical definition → null", () => {
  expect(codexMcpCommands("x", {})).toBeNull();
  expect(codexMcpCommands("x", null)).toBeNull();
});

test("buildCodexSyncCommands: marketplaces, plugins, MCP; untranslatable ones reported in skipped", () => {
  const setup = {
    marketplaces: [{ name: "infra-marketplace", source: "https://github.com/acme/infra-marketplace.git" }],
    plugins: ["infra-skills@infra-marketplace"],
  };
  const { cmds, skipped } = buildCodexSyncCommands(setup, { broken: { foo: 1 } });
  const flat = cmds.map((c) => c.join(" "));
  expect(flat).toContain("codex plugin marketplace add https://github.com/acme/infra-marketplace.git");
  expect(flat).toContain("codex plugin add infra-skills@infra-marketplace");
  // the marketplace must be registered before a plugin is installed from it
  expect(flat.indexOf("codex plugin marketplace add https://github.com/acme/infra-marketplace.git"))
    .toBeLessThan(flat.indexOf("codex plugin add infra-skills@infra-marketplace"));
  // built-in caveman and playwright are registered for Codex too
  expect(flat).toContain("codex plugin marketplace add JuliusBrussee/caveman");
  expect(flat).toContain("codex plugin add caveman@caveman");
  expect(cmds.some((c) => c.join(" ").includes("mcp add playwright"))).toBe(true);
  // Codex passes env into an stdio MCP server only per the `env_vars` allow-list — without
  // it DISPLAY/DEVBOX_HEADED would not reach playwright-mcp-devbox on InstaBox.
  expect(cmds.some((c) => c.join(" ").includes('env_vars = ["DEVBOX_HEADED", "DISPLAY"]'))).toBe(true);
  expect(skipped).toEqual(["broken"]);
});

// --- Fix round 1: TOML escaping, table-name escaping, secret-safe logging --------------

test("codexMcpCommands: a header value with a quote/backslash/apostrophe/newline/$ is TOML-escaped correctly", () => {
  const cmds = codexMcpCommands("svc", {
    type: "http", url: "https://example.test/mcp",
    headers: {
      Quote: 'has "quotes"',
      Backslash: "back\\slash",
      Apostrophe: "it's",
      Newline: "line1\nline2",
      Dollar: "$HOME",
    },
  })!;
  const script = cmds[1][2];
  // TOML basic string escaping: \\ and " are escaped, newline → \n literal (two chars),
  // apostrophe and $ are not escaped in TOML (they are not control/reserved chars).
  expect(script).toContain('Quote = "has \\"quotes\\""');
  expect(script).toContain('Backslash = "back\\\\slash"');
  // The apostrophe is not escaped in TOML (not a control/reserved char) — it stays as a literal
  // "it's" in the TOML value, but the whole block then goes through shQuote (see below), which
  // rewrites it for the bash single-quoted context to the POSIX pattern 'it'\''s'.
  expect(script).toContain("Apostrophe = \"it'\\''s\"");
  expect(script).toContain('Newline = "line1\\nline2"'); // literal \n as 2 chars, not a real line break
  expect(script).not.toContain("line1\nline2"); // a real newline would break TOML syntax
  expect(script).toContain('Dollar = "$HOME"');
  // Leading \n: a defensive guard against config.toml without a trailing newline (otherwise
  // the block's first line would stick to the last existing line and break TOML syntax).
  expect(script.startsWith("printf '\\n%s\\n' '")).toBe(true);
});

test("codexMcpCommands: a control char outside the named escapes goes as \\u00XX", () => {
  const cmds = codexMcpCommands("svc", {
    type: "http", url: "https://example.test/mcp",
    headers: { X: "a\x01b" }, // SOH, a control char without a named TOML escape
  })!;
  expect(cmds[1][2]).toContain('X = "a\\u0001b"');
});

test("codexMcpCommands: a dangerous server name is quoted in the TOML table, not inserted bare", () => {
  const cmds = codexMcpCommands("weird name", {
    type: "http", url: "https://example.test/mcp", headers: { X: "y" },
  })!;
  expect(cmds[1][2]).toContain('[mcp_servers."weird name".http_headers]');
  expect(cmds[1][2]).not.toContain("[mcp_servers.weird name.http_headers]");
});

test("codexMcpCommands: a safe server name (even with a dash) stays unquoted in the TOML table", () => {
  // regression guard for the existing test above ("time-tracking") — the bare-key grammar
  // for a table name may allow a dash without quotes.
  const cmds = codexMcpCommands("time-tracking", {
    type: "http", url: "https://example.test/mcp", headers: { X: "y" },
  })!;
  expect(cmds[1][2]).toContain("[mcp_servers.time-tracking.http_headers]");
});

test("describeCommand: bash -lc (secret-bearing) is never printed in full, even with a token inside", () => {
  const cmd = ["bash", "-lc", 'printf \'%s\\n\' \'Authorization = "Bearer s3cr3t-token"\' >> config.toml'];
  const label = describeCommand(cmd);
  expect(label).not.toContain("s3cr3t-token");
  expect(label).not.toContain("Bearer");
  expect(isSecretBearingCommand(cmd)).toBe(true);
});

test("describeCommand: a regular codex/claude command keeps the existing behavior (first 5 tokens)", () => {
  const cmd = ["codex", "mcp", "add", "time-tracking", "--url", "https://tracker.acme.example/api/mcp"];
  expect(describeCommand(cmd)).toBe(cmd.slice(0, 5).join(" "));
  expect(isSecretBearingCommand(cmd)).toBe(false);
});

// --- Fix round (Task 10): the FAIL branch in agent-sync.ts logs the raw stdout/stderr of the failed
// command, not just its shortened label. If the CLI echoed its arguments back on error,
// the token would leak even for commands that carry it as an argv element (not just bash -lc). The tests below
// cover Codex's stdio `--env` and Claude's `add-json` — symmetric to Grok's test above.

test("codexMcpCommands: stdio --env IS secret-bearing (token in argv, the FAIL branch may print it)", () => {
  const cmds = codexMcpCommands("infra-docs", { command: "node", args: ["index.js"], env: { TOKEN: "s3cr3t" } })!;
  const withEnv = cmds.find((c) => c.includes("--env"));
  expect(withEnv).toBeDefined();
  expect(isSecretBearingCommand(withEnv!)).toBe(true);
  expect(describeCommand(withEnv!)).not.toContain("s3cr3t");
});

test("buildSyncCommands: claude mcp add-json IS secret-bearing (the whole definition in one arg)", () => {
  const s = buildSetupFromMacState(undefined, undefined);
  const cmds = buildSyncCommands(s, { api: { type: "http", url: "https://x", headers: { Authorization: "Bearer s3cr3t" } } });
  const addJson = cmds.find((c) => c[2] === "add-json" && c[5] === "api");
  expect(addJson).toBeDefined();
  expect(isSecretBearingCommand(addJson!)).toBe(true);
  expect(describeCommand(addJson!)).not.toContain("s3cr3t");
});

// --- Built-in marketplaces, plugins and serena ------------------------------------------

test("the built-in marketplace and plugins are in the commands even with an empty mac state", () => {
  const cmds = buildSyncCommands({ marketplaces: [], plugins: [] });
  const flat = cmds.map((c) => c.join(" "));
  expect(flat).toContain("claude plugin marketplace add JuliusBrussee/caveman");
  expect(flat).toContain("claude plugin install caveman@caveman");
  expect(flat).toContain("claude plugin install typescript-lsp@claude-plugins-official");
});

test("buildSetupFromMacState skips infra-mcp — in the container it would carry unexpanded ${…}", () => {
  const setup = buildSetupFromMacState({}, { plugins: {
    "infra-skills@infra-marketplace": {}, "infra-mcp@infra-marketplace": {}, "superpowers@claude-plugins-official": {},
  } }, new Set(["infra-mcp@infra-marketplace"]));
  expect(setup.plugins).toContain("infra-skills@infra-marketplace");
  expect(setup.plugins).toContain("superpowers@claude-plugins-official");
  // MCP servers reach containers from devd's vault already expanded; the plugin would build
  // the same definitions next to them with ${VARIABLES} that nobody fills in there.
  expect(setup.plugins).not.toContain("infra-mcp@infra-marketplace");
});

test("serena is a built-in MCP with an stdio command and the ide context", () => {
  const cmds = buildSyncCommands({ marketplaces: [], plugins: [] });
  // `add-json` explicitly: since the idempotent `remove` was introduced, every server has
  // a pair of commands and a plain c.includes("serena") would hit the removing one.
  const serena = cmds.find((c) => c[1] === "mcp" && c[2] === "add-json" && c.includes("serena"));
  expect(serena).toBeDefined();
  const def = JSON.parse(serena![serena!.length - 1]) as { command: string; args: string[] };
  expect(def.command).toBe("serena");
  expect(def.args).toEqual(["start-mcp-server", "--context", "ide"]);
});

test("a marketplace from the mac state is not duplicated with the built-in", () => {
  const cmds = buildSyncCommands({
    marketplaces: [{ name: "caveman", source: "JuliusBrussee/caveman" }], plugins: [],
  });
  const adds = cmds.map((c) => c.join(" ")).filter((s) => s.includes("marketplace add JuliusBrussee/caveman"));
  expect(adds).toHaveLength(1);
});

test("a plugin from the mac state is not duplicated with the built-in", () => {
  const cmds = buildSyncCommands({ marketplaces: [], plugins: ["caveman@caveman"] });
  const installs = cmds.map((c) => c.join(" ")).filter((s) => s === "claude plugin install caveman@caveman");
  expect(installs).toHaveLength(1);
});

test("the Codex arm gets built-in marketplaces, plugins and serena", () => {
  const { cmds } = buildCodexSyncCommands({ marketplaces: [], plugins: [] });
  const flat = cmds.map((c) => c.join(" "));
  expect(flat).toContain("codex plugin marketplace add JuliusBrussee/caveman");
  expect(flat).toContain("codex plugin add caveman@caveman");
  expect(flat.some((s) => s.includes("serena"))).toBe(true);
});

// --- Fix round 2: typescript-lsp must not depend on only the mac having the marketplace -------

test("claude-plugins-official (typescript-lsp marketplace) is built-in, not only from the mac", () => {
  const cmds = buildSyncCommands({ marketplaces: [], plugins: [] });
  const flat = cmds.map((c) => c.join(" "));
  expect(flat).toContain("claude plugin marketplace add anthropics/claude-plugins-official");
});

test("claude-plugins-official from the mac state is not duplicated with the built-in", () => {
  const cmds = buildSyncCommands({
    marketplaces: [{ name: "claude-plugins-official", source: "anthropics/claude-plugins-official" }], plugins: [],
  });
  const adds = cmds.map((c) => c.join(" ")).filter((s) => s.includes("marketplace add anthropics/claude-plugins-official"));
  expect(adds).toHaveLength(1);
});

test("invariant: the marketplace of every built-in plugin is built-in too", () => {
  // A built-in plugin must not depend on the user not having deleted its marketplace
  // from the mac — otherwise `plugin install` on a fresh devbox fails with "not found in marketplace".
  const builtinMarketplaceNames = new Set(BUILTIN_MARKETPLACES.map((m) => m.name));
  for (const plugin of BUILTIN_PLUGINS) {
    const marketplace = plugin.split("@")[1];
    expect(builtinMarketplaceNames.has(marketplace)).toBe(true);
  }
});

// --- Grok arm --------------------------------------------------------------------------
// grokSetup: a minimal ClaudeSetup with one marketplace and plugin from the mac, used across
// the tests below — same name and shape as in the Task 10 brief.
const grokSetup = { marketplaces: [{ name: "org-repo", source: "org/repo" }], plugins: ["skill@market"] };

test("grok gets marketplaces, plugins and MCP servers", () => {
  const { cmds } = buildGrokSyncCommands(grokSetup, { serena: { command: "uvx", args: ["serena"] } });
  const flat = cmds.map((c) => c.join(" "));
  expect(flat.some((c) => c.startsWith("grok plugin marketplace add"))).toBe(true);
  // `install --trust`, not `add`: `grok plugin add` does not exist (verified live on 1.0.5)
  // and without `--trust` the install stops on a prompt, i.e. silently fails in automation.
  expect(flat.some((c) => c.startsWith("grok plugin install") && c.endsWith("--trust"))).toBe(true);
  expect(flat.some((c) => c.startsWith("grok plugin add"))).toBe(false);
  expect(flat.some((c) => c.includes("mcp") && c.includes("serena"))).toBe(true);
});

test("an untranslatable definition is skipped and reported, not silently dropped", () => {
  const { skipped } = buildGrokSyncCommands(grokSetup, { weird: { something: true } });
  expect(skipped).toContain("weird");
});

// Verified live in a throwaway container (Task 10, grok 1.0.5): `grok mcp add` supports HTTP headers
// (`-H`/`--header`) and env variables (`-e`/`--env`) directly as argv flags and writes them itself into
// `~/.grok/config.toml` (`[mcp_servers.<name>.headers]` or `.env`), including TOML escaping
// of values with quotes/backslashes — unlike `codex mcp add`, where this header
// path is missing and a workaround via a `bash -lc` append is needed. So with Grok the token stays
// a separate argv element, never part of a shell string, so on the SUCCESS branch
// the shortened label alone would suffice. But the fix round review showed that on the FAIL branch in
// agent-sync.ts the raw stdout/stderr of the command is logged — if `grok` echoed
// its arguments back on error, the token would leak anyway. `isSecretBearingCommand` therefore
// RECOGNIZES this shape (`-H`) as secret-bearing (see isSecretBearingCommand in claudeSetup.ts), same
// as Codex's `--env`.
test("a command carrying a token via argv (-H) IS secret-bearing (because of the FAIL branch in agent-sync.ts)", () => {
  const { cmds } = buildGrokSyncCommands(grokSetup, { api: { url: "https://x", headers: { Authorization: "Bearer t" } } });
  const withToken = cmds.find((c) => c.join(" ").includes("Bearer t"));
  expect(withToken).toBeDefined();
  expect(cmds.some(isSecretBearingCommand)).toBe(true);
  // Even as secret-bearing the shortened label stays safe — the token is always past position 5.
  expect(describeCommand(withToken!)).not.toContain("Bearer t");
});

test("grokMcpCommands: stdio server → a single add with -e and arguments after --", () => {
  expect(grokMcpCommands("infra-docs", { command: "node", args: ["/opt/infra-docs-mcp/index.js"], env: { INFRA_DOCS_TOKEN: "t0ken" } })).toEqual([
    ["grok", "mcp", "add", "infra-docs", "-e", "INFRA_DOCS_TOKEN=t0ken", "--", "node", "/opt/infra-docs-mcp/index.js"],
  ]);
});

test("grokMcpCommands: http server with headers → a single add with --transport http and -H", () => {
  expect(grokMcpCommands("time-tracking", {
    url: "https://tracker.acme.example/api/mcp", headers: { Authorization: "Bearer abc", "CF-Access-Client-Id": "cid" },
  })).toEqual([
    ["grok", "mcp", "add", "time-tracking", "--transport", "http", "https://tracker.acme.example/api/mcp",
      "-H", "Authorization: Bearer abc", "-H", "CF-Access-Client-Id: cid"],
  ]);
});

test("grokMcpCommands: nonsensical definition → null", () => {
  expect(grokMcpCommands("x", {})).toBeNull();
  expect(grokMcpCommands("x", null)).toBeNull();
});

test("the Grok arm gets built-in marketplaces and serena; skips caveman and *-lsp", () => {
  const { cmds, skippedPlugins } = buildGrokSyncCommands({ marketplaces: [], plugins: [] });
  const flat = cmds.map((c) => c.join(" "));
  // The marketplace is still registered — Grok may want other plugins from it.
  expect(flat).toContain("grok plugin marketplace add JuliusBrussee/caveman");
  expect(flat.some((s) => s.includes("serena"))).toBe(true);
  // caveman and typescript-lsp are built-in, but Grok cannot install them; instead of
  // four FAILs on every sync they are skipped and reported.
  expect(flat.some((s) => s.includes("plugin install caveman@caveman"))).toBe(false);
  expect(flat.some((s) => s.includes("plugin install typescript-lsp"))).toBe(false);
  expect(skippedPlugins.some((s) => s.startsWith("caveman@caveman"))).toBe(true);
  expect(skippedPlugins.some((s) => s.startsWith("typescript-lsp@"))).toBe(true);
});

test("grokCannotInstall: LSP and the root-level caveman yes, a regular plugin no", () => {
  expect(grokCannotInstall("lua-lsp@claude-plugins-official")).toContain("LSP");
  expect(grokCannotInstall("swift-lsp@claude-plugins-official")).toContain("LSP");
  expect(grokCannotInstall("caveman@caveman")).toContain("repo root");
  expect(grokCannotInstall("infra-skills@infra-marketplace")).toBeNull();
  expect(grokCannotInstall("superpowers@claude-plugins-official")).toBeNull();
});

test("the marketplace is registered before the plugin that installs from it", () => {
  const { cmds } = buildGrokSyncCommands({
    marketplaces: [{ name: "infra-marketplace", source: "https://github.com/acme/infra-marketplace.git" }],
    plugins: ["infra-skills@infra-marketplace"],
  });
  const flat = cmds.map((c) => c.join(" "));
  expect(flat.indexOf("grok plugin marketplace add https://github.com/acme/infra-marketplace.git"))
    .toBeLessThan(flat.indexOf("grok plugin install infra-skills@infra-marketplace --trust"));
});

// --- Antigravity (agy) arm -------------------------------------------------------------
// Measured live on agy 1.3.5: flags (--env/--header) MUST come before the name, -- separates
// the command from its arguments; add under an existing name overwrites the whole entry (no remove).

test("agyMcpCommands: stdio with env — flags before the name, -- before the command", () => {
  expect(agyMcpCommands("fs", { command: "npx", args: ["-y", "srv", "/w"], env: { A: "b" } }))
    .toEqual([["agy", "mcp", "add", "--env", "A=b", "fs", "--", "npx", "-y", "srv", "/w"]]);
});

test("agyMcpCommands: http with a header", () => {
  expect(agyMcpCommands("api", { url: "https://x/mcp", headers: { Authorization: "Bearer T" } }))
    .toEqual([["agy", "mcp", "add", "--header", "Authorization: Bearer T", "api", "https://x/mcp"]]);
});

test("agyMcpCommands: untranslatable definition → null", () => {
  expect(agyMcpCommands("x", {})).toBeNull();
  expect(agyMcpCommands("x", null)).toBeNull();
});

test("agy mcp add with --env/--header is secret-bearing (label and error are redacted)", () => {
  expect(isSecretBearingCommand(["agy", "mcp", "add", "--header", "Authorization: Bearer T", "api", "https://x"])).toBe(true);
  expect(isSecretBearingCommand(["agy", "mcp", "add", "--env", "K=v", "fs", "--", "npx"])).toBe(true);
  expect(describeCommand(["agy", "mcp", "add", "--header", "Authorization: Bearer T", "api", "https://x"])).not.toContain("Bearer T");
});

// --- Fix round 1 (review): `agy mcp add <name> <url>` WITHOUT headers has no -H/--env
// flag, so previously it did not fall under isSecretBearingCommand at all — a URL with a token in the query
// string (`?api_key=…`) thus leaked in the five-token label (the URL sits at position 4) and in
// the raw FAIL output. looksSecret is now checked over all commands, not just add-json.

test("agy mcp add without headers with a token in the URL (?api_key=…) IS secret-bearing, the label must not contain it", () => {
  const cmd = ["agy", "mcp", "add", "api", "https://x/mcp?api_key=SECRET"];
  expect(isSecretBearingCommand(cmd)).toBe(true);
  const label = describeCommand(cmd);
  expect(label).not.toContain("SECRET");
  // the server name is cheap to keep visible — it is not a secret.
  expect(label).toContain("api");
});

// --- Finding 2 (phase 1b review): `looksSecret` catches only keywords/query parameters,
// not secrets hidden in the URL PATH (n8n `/mcp/<uuid>/sse`, Zapier `/s/<key>/mcp` etc.).
// `describeCommand`'s five-token shortening printed such a URL in full (the URL sits at position
// 4) and the FAIL branch in agent-sync.ts logged it raw too. Codex/grok/claude never show the URL
// (it sits at position ≥5), so this only concerns `agy mcp add <name> <url>` —
// every such http(s) URL is therefore now secret-bearing regardless of content, and the label
// shows the server name but never the URL (`agy mcp add <name> <redacted>`).
test("agy mcp add with a secret in the URL PATH (n8n /mcp/<uuid>/sse) IS secret-bearing, the URL is not shown in the label", () => {
  const cmd = ["agy", "mcp", "add", "n8n", "https://host.example/mcp/3f9a7b2e-55fa-4a0a-9abc-abcdefabcdef/sse"];
  expect(isSecretBearingCommand(cmd)).toBe(true);
  expect(describeCommand(cmd)).toBe("agy mcp add n8n <redacted>");
});

test("agy mcp add with a secret in the URL PATH (Zapier /s/<key>/mcp) IS secret-bearing, the URL is not shown in the label", () => {
  const cmd = ["agy", "mcp", "add", "zapier", "https://mcp.zapier.com/s/abc123secretkey/mcp"];
  expect(isSecretBearingCommand(cmd)).toBe(true);
  const label = describeCommand(cmd);
  expect(label).toBe("agy mcp add zapier <redacted>");
  expect(label).not.toContain("abc123secretkey");
});

test("agy mcp add without a URL argument (stdio, no secret names) keeps the existing label", () => {
  const cmd = ["agy", "mcp", "add", "fs", "--", "npx", "mcp-server-fs"];
  expect(isSecretBearingCommand(cmd)).toBe(false);
  expect(describeCommand(cmd)).toBe(cmd.slice(0, 5).join(" "));
});

test("agy mcp add without a secret in the URL is now redacted too (narrow fix: every http(s) URL in agy add is secret-bearing)", () => {
  const cmd = ["agy", "mcp", "add", "public", "https://example.com/mcp"];
  expect(isSecretBearingCommand(cmd)).toBe(true);
  expect(describeCommand(cmd)).toBe("agy mcp add public <redacted>");
});

test("agy mcp add with --env: the label does not contain the value (K=v)", () => {
  const cmd = ["agy", "mcp", "add", "--env", "K=v", "fs", "--", "npx"];
  expect(describeCommand(cmd)).not.toContain("K=v");
});

// --- Fix round 2 (review): a bare `key=` query parameter (Google/Firebase style) -------
// `token|secret|api[-_]?key|authorization` does not catch `?key=…` or `&key=…` — "key" by
// itself was not in the list. The new pattern must match ONLY the query parameter name, not
// any substring match, otherwise it would redact harmless "keycloak"/"monkey" too.

test("agy mcp add with ?key=… (Google/Firebase style) IS secret-bearing, the label must not contain it", () => {
  const cmd = ["agy", "mcp", "add", "maps", "https://host/mcp?key=AIzaSyD0000FAKEFIREBASE1111"];
  expect(isSecretBearingCommand(cmd)).toBe(true);
  const label = describeCommand(cmd);
  expect(label).not.toContain("AIzaSyD0000FAKEFIREBASE1111");
  expect(label).toContain("maps");
});

test("agy mcp add with &key=… (not the first query parameter) IS secret-bearing too", () => {
  const cmd = ["agy", "mcp", "add", "maps", "https://host/mcp?foo=1&key=AIzaSyD0000FAKEFIREBASE1111"];
  expect(isSecretBearingCommand(cmd)).toBe(true);
  expect(describeCommand(cmd)).not.toContain("AIzaSyD0000FAKEFIREBASE1111");
});

test("a server whose name/URL contains \"keycloak\" WITHOUT a key= query parameter is redacted too since Finding 2 (every agy http(s) URL is secret-bearing)", () => {
  const cmd = ["agy", "mcp", "add", "keycloak", "https://keycloak.example.com/mcp"];
  expect(isSecretBearingCommand(cmd)).toBe(true);
  expect(describeCommand(cmd)).toBe("agy mcp add keycloak <redacted>");
});

test("parseAgyMcpNames reads mcpServers keys and tolerates broken JSON", () => {
  expect(parseAgyMcpNames(JSON.stringify({ mcpServers: { b: {}, a: {} } }))).toEqual(["a", "b"]);
  expect(parseAgyMcpNames("")).toEqual([]);
  expect(parseAgyMcpNames("{rozbite")).toEqual([]);
});

test("buildAgySyncCommands: built-ins and catalog, untranslatable ones reported in skipped", () => {
  const { cmds, skipped } = buildAgySyncCommands({ marketplaces: [], plugins: [] }, { context7: { url: "https://mcp.context7.com" }, broken: {} });
  const flat = cmds.map((c) => c.join(" "));
  expect(flat.some((s) => s.includes("agy mcp add") && s.includes("playwright"))).toBe(true);
  expect(flat.some((s) => s.includes("context7"))).toBe(true);
  expect(skipped).toEqual(["broken"]);
});

// --- Pruning (agent-sync --prune) -------------------------------------------------------

test("parseClaudeMcpNames: names from .claude.json, a broken file → empty", () => {
  expect(parseClaudeMcpNames(JSON.stringify({ mcpServers: { zeta: {}, alpha: {} }, other: 1 }))).toEqual(["alpha", "zeta"]);
  expect(parseClaudeMcpNames("{ this is not JSON")).toEqual([]);
  expect(parseClaudeMcpNames("")).toEqual([]);
});

test("parseTomlMcpNames: only first-level tables, not http_headers/env subtables", () => {
  const toml = [
    "[some_other]", 'x = "1"',
    "[mcp_servers.context7]", 'url = "https://mcp.context7.com"',
    "[mcp_servers.context7.http_headers]", 'Authorization = "Bearer x"',
    "[mcp_servers.time-tracking]", 'url = "https://t"',
    "[mcp_servers.playwright]", 'command = "playwright-mcp"',
    "[mcp_servers.playwright.env]", 'A = "b"',
  ].join("\n");
  expect(parseTomlMcpNames(toml)).toEqual(["context7", "playwright", "time-tracking"]);
});

test("parseTomlMcpNames: a quoted name is unescaped (otherwise it would be deleted over and over)", () => {
  expect(parseTomlMcpNames('[mcp_servers."odd name"]\nurl = "x"')).toEqual(["odd name"]);
  expect(parseTomlMcpNames('[mcp_servers."a\\"b"]')).toEqual(['a"b']);
});

test("desiredMcpNames contains built-ins and the catalog", () => {
  const d = desiredMcpNames({ context7: {} });
  expect(d.has("context7")).toBe(true);
  expect(d.has("playwright")).toBe(true);
  expect(d.has("serena")).toBe(true);
});

test("buildPruneCommands removes only what is not in the catalog", () => {
  const removals = buildPruneCommands(desiredMcpNames({ context7: {} }), {
    claude: ["context7", "playwright", "old-server"],
    codex: ["context7", "other-old"],
    grok: ["context7"],
    agy: [],
  });
  expect(removals).toEqual([
    { agent: "claude", name: "old-server", cmd: ["claude", "mcp", "remove", "old-server", "-s", "user"] },
    { agent: "codex", name: "other-old", cmd: ["codex", "mcp", "remove", "other-old"] },
  ]);
});

test("buildPruneCommands: a built-in server is never pruned, even with an empty catalog", () => {
  const removals = buildPruneCommands(desiredMcpNames({}), { claude: ["playwright", "serena"], codex: [], grok: [], agy: [] });
  expect(removals).toEqual([]);
});

test("buildPruneCommands: nothing extra → empty (no extra container run)", () => {
  expect(buildPruneCommands(desiredMcpNames({ a: {} }), { claude: ["a"], codex: ["a"], grok: ["a"], agy: ["a"] })).toEqual([]);
});

test("prune removes the surplus from agy too", () => {
  const out = buildPruneCommands(new Set(["keep"]), { claude: [], codex: [], grok: [], agy: ["keep", "old"] });
  expect(out).toEqual([{ agent: "agy", name: "old", cmd: ["agy", "mcp", "remove", "old"] }]);
});

// --- Task 8: the stdio bridge to mac-mcp-bridge (xcode) must be translated for all three arms --

test("the stdio MCP bridge (mac-mcp-bridge) is translated for Claude, Codex and Grok", () => {
  const def = { command: "/opt/mac-mcp-bridge/bridge.py", args: ["/opt/mac-mcp/xcode/registration.json"] };

  // For Claude/Codex `remove` goes first (idempotence) and it does not mention bridge.py at all —
  // hence .some() over all commands, not "the first command mentioning xcode": for both Claude
  // and Codex that would hit exactly the removing one and would only prove that the server name got through, not that
  // the bridge really got translated into a runnable command.
  const claude = buildSyncCommands({ marketplaces: [], plugins: [] }, { xcode: def });
  expect(claude.some((c) => c.includes("xcode") && c.join(" ").includes("bridge.py"))).toBe(true);

  const codex = buildCodexSyncCommands({ marketplaces: [], plugins: [] }, { xcode: def });
  expect(codex.cmds.some((c) => c.includes("xcode") && c.join(" ").includes("bridge.py"))).toBe(true);
  expect(codex.skipped).not.toContain("xcode");

  const grok = buildGrokSyncCommands({ marketplaces: [], plugins: [] }, { xcode: def });
  expect(grok.cmds.some((c) => c.includes("xcode") && c.join(" ").includes("bridge.py"))).toBe(true);
  expect(grok.skipped).not.toContain("xcode");
});
