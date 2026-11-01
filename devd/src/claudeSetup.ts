export interface ClaudeSetup {
  marketplaces: { name: string; source: string }[];
  plugins: string[];
}

interface KnownMarketplaces {
  [name: string]: { source: { source: string; repo?: string; url?: string } };
}
interface InstalledPlugins { version: number; plugins: Record<string, unknown> }

/** Plugins that supply MCP servers on the mac but must not end up in containers
 *  (DEVBOX_MCP_ONLY_PLUGINS, comma-separated, e.g. `team-mcp@team-marketplace`).
 *
 *  Such a plugin carries definitions with ${VARIABLES}. On the mac 1Password fills them via `op run`;
 *  in the container nobody fills them — the values arrive there from the devd vault (agent-secrets
 *  → this file → agent-sync), already expanded. If the plugin were installed here too,
 *  the expanded servers would sit next to the same definitions once more with unexpanded
 *  ${…} — i.e. duplicate and broken entries.
 *
 *  The marketplace is still installed, just not these plugins from it. */
const MCP_ONLY_PLUGINS = new Set((process.env.DEVBOX_MCP_ONLY_PLUGINS ?? "").split(",").map((p) => p.trim()).filter(Boolean));

export function buildSetupFromMacState(known: unknown, installed: unknown, mcpOnly: Set<string> = MCP_ONLY_PLUGINS): ClaudeSetup {
  const km = (known ?? {}) as KnownMarketplaces;
  const marketplaces = Object.entries(km)
    .map(([name, m]) => ({ name, source: m?.source?.repo ?? m?.source?.url ?? "" }))
    .filter((m) => m.source !== "")
    .sort((a, b) => a.name.localeCompare(b.name));
  const ip = installed as InstalledPlugins | undefined;
  const plugins = Object.keys(ip?.plugins ?? {}).sort().filter((p) => !mcpOnly.has(p));
  return { marketplaces, plugins };
}

const BUILTIN_MCP: Record<string, unknown> = {
  // `sh -c` with a fallback, NOT `playwright-mcp-devbox` directly: agent-sync writes this
  // definition into the SHARED volumes (claude-home/codex-home/grok-home) on EVERY sync
  // run, regardless of which image the container booted from. A running VPS session on an
  // older image (without the wrapper in /usr/local/bin) would after sync be left with a command
  // that does not exist in it → Playwright MCP would stop working entirely instead of staying
  // headless as before. `command -v` checks whether the wrapper is on PATH, and without it runs
  // the old bare binary with `--headless` — the exact previous behaviour. `"$@"` in a -c script reads
  // argv FROM $0 onwards, which is why `playwright-mcp` (the future $0, unused) is in 3rd position and
  // the actual flags `--browser chromium --no-sandbox` come after it.
  // Headed/headless inside the wrapper is decided by the container env (DEVBOX_HEADED=1 only on
  // InstaBox, see image/playwright-mcp-devbox). `env_vars` is for Codex only (Claude
  // filters CODEX_MCP_FIELDS out) — Codex does not pass env to stdio MCP servers without an
  // explicit allow-list; without it DISPLAY/DEVBOX_HEADED would not reach the wrapper.
  playwright: {
    command: "sh",
    args: [
      "-c",
      'if command -v playwright-mcp-devbox >/dev/null 2>&1; then exec playwright-mcp-devbox "$@"; else exec playwright-mcp --headless "$@"; fi',
      "playwright-mcp", "--browser", "chromium", "--no-sandbox",
    ],
    env_vars: ["DEVBOX_HEADED", "DISPLAY"],
  },
  // Semantic code reading and editing via LSP. The binary is in the image at /usr/local/bin
  // (see Dockerfile and spec — installed via uv with UV_* variables, otherwise the
  // `dev` user could not run it). `--context ide` is the authors' recommendation for clients that
  // have their own file reading; the default `desktop-app` would duplicate the tool set.
  serena: { command: "serena", args: ["start-mcp-server", "--context", "ide"] },
};

// Marketplaces and plugins the devbox needs regardless of what anyone has on the mac.
// Same logic as BUILTIN_MCP: the mac state takes precedence, so the user can
// force their own version, but without it the tools are not missing here.
// Exported so a test can verify the invariant "the marketplace of every built-in
// plugin is built-in too" directly on the real data, not on a rewritten copy.
export const BUILTIN_MARKETPLACES: { name: string; source: string }[] = [
  { name: "caveman", source: "JuliusBrussee/caveman" },
  // typescript-lsp (below) is from the official marketplace — it must be built in here too,
  // otherwise a built-in plugin would depend on the user not deleting it from the mac (see below).
  { name: "claude-plugins-official", source: "anthropics/claude-plugins-official" },
];
// typescript-lsp is here because an LSP server can be declared ONLY by a plugin — without it the
// typescript-language-server binary in the image is useless. The marketplace it is installed
// from (claude-plugins-official) MUST be built in too — otherwise the built-in
// plugin would depend on the user happening to have that marketplace on the mac; if they
// removed it, `plugin install` on a fresh devbox would fail with "not found in marketplace".
export const BUILTIN_PLUGINS: string[] = [
  "caveman@caveman",
  "typescript-lsp@claude-plugins-official",
];

/** Merges built-in entries with the mac state so that none repeats (dedup by
 *  `keyOf`). Built-in ones go first — for marketplaces this is required so that `caveman@caveman`
 *  has its marketplace registered before the plugin is installed. */
function withBuiltins<T>(builtin: T[], fromMac: T[], keyOf: (v: T) => string): T[] {
  const macKeys = new Set(fromMac.map(keyOf));
  return [...builtin.filter((b) => !macKeys.has(keyOf(b))), ...fromMac];
}

/** Runtime shim fixes the installed v2.12 Coolify deploy method for every agent.
 *  Preserve user Node flags; do not touch remote HTTP connectors or unrelated MCPs. */
export function withCoolifyCompatibility(servers: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(servers).map(([name, raw]) => {
    const def = raw as { command?: string; env?: Record<string, string> } | undefined;
    if (!name.endsWith("-coolify") || !def?.command || !def.env?.COOLIFY_BASE_URL) return [name, raw];
    const previous = def.env.NODE_OPTIONS ?? "";
    const shim = "/opt/coolify-cf-shim.cjs";
    return [name, { ...def, env: { ...def.env, NODE_OPTIONS: previous.includes(shim) ? previous : `${previous} --require ${shim}`.trim() } }];
  }));
}

const CODEX_MCP_FIELDS = ["env_vars", "startup_timeout_sec", "tool_timeout_sec", "enabled"] as const;

function claudeMcpDefinition(def: unknown): unknown {
  if (!def || typeof def !== "object" || Array.isArray(def)) return def;
  return Object.fromEntries(Object.entries(def).filter(([key]) => !CODEX_MCP_FIELDS.some(field => field === key)));
}

export function buildSyncCommands(setup: ClaudeSetup, mcpServers: Record<string, unknown> = {}): string[][] {
  const cmds: string[][] = [];
  const marketplaces = withBuiltins(BUILTIN_MARKETPLACES, setup.marketplaces, (m) => m.source);
  const plugins = withBuiltins(BUILTIN_PLUGINS, setup.plugins, (p) => p);
  for (const m of marketplaces) cmds.push(["claude", "plugin", "marketplace", "add", m.source]);
  for (const p of plugins) cmds.push(["claude", "plugin", "install", p]);
  const merged = { ...BUILTIN_MCP, ...withCoolifyCompatibility(mcpServers) }; // a secret with the same name overrides the built-in
  for (const [name, def] of Object.entries(merged).sort(([a], [b]) => a.localeCompare(b))) {
    // `remove` first = idempotence, same as in the Codex arm. Without it
    // `add-json` does NOT OVERWRITE an existing server — it just says "already exists in user
    // config", which alreadyConfigured() evaluates as success. A changed definition thus
    // never reached Claude: on the devbox context7 was left without the
    // Authorization header even though the vault had it (found 2026-09-04).
    // Removing a nonexistent server is harmless — it ends with exit 0 and a message.
    cmds.push(["claude", "mcp", "remove", name, "-s", "user"]);
    cmds.push(["claude", "mcp", "add-json", "--scope", "user", name, JSON.stringify(claudeMcpDefinition(def))]);
  }
  return cmds;
}

// --- Codex arm --------------------------------------------------------------
// Codex reads the SAME marketplace manifest (.claude-plugin/marketplace.json) as Claude,
// so marketplaces and plugin names (`plugin@marketplace`) are taken over 1:1.

// TOML basic string: escapes backslash, double quote and ALL control characters (TOML spec
// for basic strings — incl. \n, \r, \t, \b, \f as named escapes, the rest \u00XX). The value
// is untrusted input (a header from secrets.json) — without escaping control characters an
// unescaped newline would break TOML syntax and in the extreme case inject a new
// `[mcp_servers.…]` table into config.toml.
function tomlString(v: string): string {
  const named: Record<string, string> = {
    "\\": "\\\\", '"': '\\"', "\n": "\\n", "\r": "\\r", "\t": "\\t", "\b": "\\b", "\f": "\\f",
  };
  const escaped = v.replace(/[\\"\x00-\x1f\x7f]/g, (ch) => named[ch] ?? `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return `"${escaped}"`;
}
// Bare key only for [A-Za-z0-9_-]; anything else (e.g. CF-Access-Client-Id is OK, but
// keys with a dot/space are not) is wrapped in quotes.
// Note: the TOML spec accepts a hyphen in a bare key as legal (even "CF-Access-Client-Id" would
// pass without quotes) — quoting headers with a hyphen is a deliberately conservative
// choice here, not a necessity. Do not "fix" it back to a bare key.
function tomlKey(k: string): string {
  return /^[A-Za-z0-9_-]+$/.test(k) ? (/-/.test(k) ? `"${k}"` : k) : tomlString(k);
}
// MCP server name = TOML table name. Unlike tomlKey (headers, where we conservatively quote
// even a legal bare key with a hyphen) here we use the full TOML bare-key grammar so that
// `[mcp_servers.time-tracking.http_headers]` stays unquoted. The name comes from secrets.json,
// not guaranteed safe — always pass it through this function, never raw interpolation.
function tomlTableName(name: string): string {
  return /^[A-Za-z0-9_-]+$/.test(name) ? name : tomlString(name);
}
// Single quoting for `bash -lc`.
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// Shape of an MCP definition as it comes from BUILTIN_MCP/secrets.json — shared between Codex and
// Grok (`codexMcpCommands`/`grokMcpCommands`) so the two literals cannot diverge.
type McpServerDef = { command?: string; args?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string> };

function codexStdioMetadata(def: Record<string, unknown>): string[] | null {
  const lines: string[] = [];
  if (def.env_vars !== undefined) {
    if (!Array.isArray(def.env_vars) || !def.env_vars.every(v => typeof v === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(v))) return null;
    lines.push(`env_vars = [${def.env_vars.map(tomlString).join(", ")}]`);
  }
  for (const key of ["startup_timeout_sec", "tool_timeout_sec"] as const) {
    const value = def[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
    lines.push(`${key} = ${value}`);
  }
  if (def.enabled !== undefined) {
    if (typeof def.enabled !== "boolean") return null;
    lines.push(`enabled = ${def.enabled}`);
  }
  return lines;
}

/** Update requested metadata in a provisioned MCP root table, leaving its env
 * subtable and unrequested keys intact. Bun is already required by provisioning. */
export function codexMetadataCommand(name: string, lines: string[], provider: "codex" | "grok" = "codex"): string[] {
  const script = `import { readFileSync, writeFileSync, realpathSync, statSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { isDeepStrictEqual } from "node:util";
const [name, header, additions, provider] = process.argv.slice(1);
const configHome = provider === "grok" ? process.env.GROK_HOME : process.env.CODEX_HOME;
const path = realpathSync(join(configHome || join(homedir(), "." + provider), "config.toml"));
const source = readFileSync(path, "utf8");
const expected = Bun.TOML.parse(source);
const server = expected.mcp_servers[name];
const metadata = Bun.TOML.parse(additions);
Object.assign(server, metadata);
const rows = source.split(/(?<=\\n)/);
const matches = rows.flatMap((row, i) => row.trim() === header ? [i] : []);
if (matches.length !== 1) throw new Error("Expected exactly one MCP root table");
const i = matches[0];
const preserved = [];
let end = i + 1;
while (end < rows.length) {
  const line = rows[end].trim();
  if (!line || line.startsWith("#")) { preserved.push(rows[end++]); continue; }
  if (line.startsWith("[")) break;
  // Parse complete assignments so an array or multiline string cannot be cut in half.
  let stop = end;
  let assignment;
  for (; stop < rows.length; stop++) {
    try { assignment = Bun.TOML.parse(rows.slice(end, stop + 1).join("")); break; }
    catch { /* the assignment may continue on the next line */ }
  }
  if (!assignment || Object.keys(assignment).length !== 1)
    throw new Error("Expected one complete MCP root assignment");
  if (!Object.hasOwn(metadata, Object.keys(assignment)[0]))
    preserved.push(...rows.slice(end, stop + 1));
  end = stop + 1;
}
const updated = rows.slice(0, i).join("") + rows[i].replace(/[\\r\\n]+$/, "") + "\\n" +
  additions + "\\n" + preserved.join("") + rows.slice(end).join("");
if (!isDeepStrictEqual(Bun.TOML.parse(updated), expected))
  throw new Error("Refusing to change unrelated MCP configuration");
const temporary = mkdtempSync(join(dirname(path), ".mcp-config-"));
try {
  const candidate = join(temporary, "config.toml");
  writeFileSync(candidate, updated, { mode: statSync(path).mode & 0o777 });
  if (readFileSync(path, "utf8") !== source)
    throw new Error("MCP configuration changed during update; retry provisioning");
  renameSync(candidate, path);
} finally { rmSync(temporary, { recursive: true, force: true }); }
`;
  return ["bash", "-lc", `bun -e ${shQuote(script)} -- ${shQuote(name)} ${shQuote(`[mcp_servers.${tomlTableName(name)}]`)} ${shQuote(lines.join("\n"))} ${shQuote(provider)}`];
}

/** Commands for one MCP server. `remove` first = idempotence (also removes subtables). */
export function codexMcpCommands(name: string, def: unknown): string[][] | null {
  const d = def as McpServerDef | null;
  if (!d || typeof d !== "object") return null;
  const remove = ["codex", "mcp", "remove", name];
  if (typeof d.command === "string" && d.command) {
    const metadata = codexStdioMetadata(d as Record<string, unknown>);
    if (metadata === null) return null;
    const env = Object.entries(d.env ?? {}).flatMap(([k, v]) => ["--env", `${k}=${v}`]);
    const cmds = [remove, ["codex", "mcp", "add", name, ...env, "--", d.command, ...(d.args ?? [])]];
    if (metadata.length) cmds.push(codexMetadataCommand(name, metadata));
    return cmds;
  }
  if (typeof d.url === "string" && d.url) {
    const headers = Object.entries(d.headers ?? {});
    // Without headers `codex mcp add` is enough: the server is public, the probe on add passes.
    if (!headers.length) return [remove, ["codex", "mcp", "add", name, "--url", d.url]];

    // With headers `codex mcp add` CANNOT BE USED. On add it contacts the server, but the
    // headers would only be appended afterwards — so the request goes out unauthorized and Codex
    // falls into OAuth: "Browser launch failed (…) timed out waiting for OAuth
    // callback". In the one-shot agent-sync container there is no way to complete OAuth.
    // (Verified 2026-09-04 on context7 with a bearer token.)
    //
    // So we write the whole block into config.toml directly. `codex mcp add` is just a
    // thin layer over the same file and knows http_headers (verified with --strict-config),
    // so we lose no functionality. `--bearer-token-env-var` would be
    // nicer, but it reads the value from the environment — here it arrives already expanded, not as a reference.
    //
    // Leading `\n` in printf: `>>` appends bytes after the last existing one, so without it
    // the first line would stick to the previous one and break TOML. The preceding `remove`
    // guarantees the block is not doubled.
    const block = [`[mcp_servers.${tomlTableName(name)}]`,
      `url = ${tomlString(d.url)}`,
      "",
      `[mcp_servers.${tomlTableName(name)}.http_headers]`,
      ...headers.map(([k, v]) => `${tomlKey(k)} = ${tomlString(v)}`), ""].join("\n");
    return [remove, ["bash", "-lc", `printf '\\n%s\\n' ${shQuote(block)} >> "\${CODEX_HOME:-$HOME/.codex}/config.toml"`]];
  }
  return null;
}

/** Codex counterpart of buildSyncCommands. `skipped` = MCP servers that could not be translated. */
export function buildCodexSyncCommands(setup: ClaudeSetup, mcpServers: Record<string, unknown> = {}): { cmds: string[][]; skipped: string[] } {
  const cmds: string[][] = [];
  const skipped: string[] = [];
  const marketplaces = withBuiltins(BUILTIN_MARKETPLACES, setup.marketplaces, (m) => m.source);
  const plugins = withBuiltins(BUILTIN_PLUGINS, setup.plugins, (p) => p);
  for (const m of marketplaces) cmds.push(["codex", "plugin", "marketplace", "add", m.source]);
  for (const p of plugins) cmds.push(["codex", "plugin", "add", p]);
  const merged = { ...BUILTIN_MCP, ...withCoolifyCompatibility(mcpServers) };
  for (const [name, def] of Object.entries(merged).sort(([a], [b]) => a.localeCompare(b))) {
    const c = codexMcpCommands(name, def);
    if (c) cmds.push(...c);
    else skipped.push(name);
  }
  return { cmds, skipped };
}

// --- Grok arm -----------------------------------------------------------------------
// Grok reads the SAME marketplace manifest as Claude/Codex, so marketplaces and
// plugin names (`plugin@marketplace`) are taken over 1:1 — same as for Codex above.

/** Commands for one MCP server on Grok. Unlike `codex mcp add`, `grok mcp add` supports
 *  HTTP headers (`-H`/`--header`) and env variables (`-e`/`--env`) directly as argv flags —
 *  verified live (Task 10, throwaway container with grok 1.0.5): grok itself writes
 *  `[mcp_servers.<name>.headers]` or `.env` into config.toml and TOML-escapes the values itself
 *  (including quotes and backslashes). So Codex's workaround via a `bash -lc`
 *  append to config.toml is NOT needed here — the token stays a separate argv element, never part
 *  of a shell string. That, however, only protects `describeCommand`'s 5-token truncation on the
 *  SUCCESS branch (the token is always past position 5); on the FAIL branch in agent-sync.ts the
 *  raw stdout/stderr of the command is logged, and if `grok` echoed its arguments back on error
 *  (a common pattern in CLI tools), the token would leak anyway. That is why `isSecretBearingCommand`
 *  below deliberately RECOGNISES this shape (`-H`/`--header`/`-e`/`--env` in argv) as
 *  secret-bearing, even though on the SUCCESS branch it would not be necessary. `grok mcp add` is also
 *  idempotent without needing remove first — adding under an existing name completely
 *  overwrites the entry (old headers/env disappear), verified live the same way. */
export function grokMcpCommands(name: string, def: unknown): string[][] | null {
  const d = def as McpServerDef | null;
  if (!d || typeof d !== "object") return null;
  if (typeof d.command === "string" && d.command) {
    const { env_vars: _forwardedByCodex, ...metadataDef } = d as unknown as Record<string, unknown>;
    const metadata = codexStdioMetadata(metadataDef);
    if (metadata === null) return null;
    const env = Object.entries(d.env ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
    const cmds = [["grok", "mcp", "add", name, ...env, "--", d.command, ...(d.args ?? [])]];
    if (metadata.length) cmds.push(codexMetadataCommand(name, metadata, "grok"));
    return cmds;
  }
  if (typeof d.url === "string" && d.url) {
    const headers = Object.entries(d.headers ?? {}).flatMap(([k, v]) => ["-H", `${k}: ${v}`]);
    return [["grok", "mcp", "add", name, "--transport", "http", d.url, ...headers]];
  }
  return null;
}

/** Plugins Grok CANNOT install — returns the reason, or null when it can be installed.
 *
 *  Without this filter four installs failed on every sync and were reported as
 *  FAIL, so real errors got lost in the noise. This is not a temporary Grok defect but
 *  two systematic mismatches (both verified live on grok 1.0.13):
 *
 *  1. `*-lsp` from claude-plugins-official are not plugins in the usual sense: their directory
 *     holds only LICENSE and README, and all content is `lspServers` in the marketplace manifest, which
 *     is a Claude Code feature. Grok has no LSP integration and reports "no plugins found in the
 *     source (no plugin.json or convention components)". Installing them into it would make no
 *     sense even if they passed.
 *  2. `caveman@caveman` has `source: "./"` in the manifest — the plugin IS the repo root. Grok
 *     cannot resolve such a source and claims "No marketplace plugin named …", even though it has the
 *     manifest in its cache and the plugin is visible in it. Plugins with source `./plugins/<x>`
 *     it installs without problems, so the difference is exactly the root source.
 *
 *  Claude and Codex handle both, so only Grok's arm is filtered. */
export function grokCannotInstall(plugin: string): string | null {
  const name = plugin.split("@")[0] ?? "";
  if (name.endsWith("-lsp")) return "LSP plugin (Claude-only, Grok has no LSP integration)";
  if (plugin === "caveman@caveman") return "plugin is the repo root (source \"./\"), Grok cannot resolve it";
  return null;
}

/** Grok counterpart of buildSyncCommands/buildCodexSyncCommands. `skipped` = MCP servers that
 *  could not be translated. */
export function buildGrokSyncCommands(setup: ClaudeSetup, mcpServers: Record<string, unknown> = {}): { cmds: string[][]; skipped: string[]; skippedPlugins: string[] } {
  const cmds: string[][] = [];
  const skipped: string[] = [];
  const skippedPlugins: string[] = [];
  const marketplaces = withBuiltins(BUILTIN_MARKETPLACES, setup.marketplaces, (m) => m.source);
  const plugins = withBuiltins(BUILTIN_PLUGINS, setup.plugins, (p) => p);
  for (const m of marketplaces) cmds.push(["grok", "plugin", "marketplace", "add", m.source]);
  // `install`, not `add` — Grok has a different vocabulary from Claude and Codex, and `add`
  // does not exist there at all (`unrecognized subcommand`), so the whole plugin block
  // broke with 32 failed commands. Measured on grok 1.0.5.
  //
  // `--trust` is required: without it the install stops on a prompt ("Plugins can run
  // hooks, MCP servers, and skills on your machine"), which in a non-interactive
  // sync means a silent failure. Skipping the confirmation is intentional here — the plugin
  // sources are the same marketplaces the user configured for Claude.
  //
  // WATCH OUT for the help text: `grok plugin install --help` claims SOURCE is a git URL or a
  // path. In reality it also recognises a bare plugin name from an added marketplace —
  // verified live, not inferred from the help text. That is why `p` is passed here unchanged,
  // same as for Claude and Codex.
  for (const p of plugins) {
    const why = grokCannotInstall(p);
    if (why) { skippedPlugins.push(`${p} (${why})`); continue; }
    cmds.push(["grok", "plugin", "install", p, "--trust"]);
  }
  const merged = { ...BUILTIN_MCP, ...withCoolifyCompatibility(mcpServers) };
  for (const [name, def] of Object.entries(merged).sort(([a], [b]) => a.localeCompare(b))) {
    const c = grokMcpCommands(name, def);
    if (c) cmds.push(...c);
    else skipped.push(name);
  }
  return { cmds, skipped, skippedPlugins };
}

// --- Antigravity (agy) arm ------------------------------------------------------------
// Antigravity reads the SAME marketplace manifest as the others, but plugin support (`agy plugin
// import`) is not wired in here yet — different format, unverified (see the comment at buildAgySyncCommands).

/** Commands for one MCP server in the Antigravity CLI. Syntax measured on agy 1.3.5:
 *  flags (`--env`, `--header`) MUST come before the name, `--` separates the command, add under an
 *  existing name overwrites the whole entry — so one command is enough, no remove. */
export function agyMcpCommands(name: string, def: unknown): string[][] | null {
  const d = def as McpServerDef | null;
  if (!d || typeof d !== "object") return null;
  if (typeof d.command === "string" && d.command) {
    const env = Object.entries(d.env ?? {}).flatMap(([k, v]) => ["--env", `${k}=${v}`]);
    return [["agy", "mcp", "add", ...env, name, "--", d.command, ...(d.args ?? [])]];
  }
  if (typeof d.url === "string" && d.url) {
    const headers = Object.entries(d.headers ?? {}).flatMap(([k, v]) => ["--header", `${k}: ${v}`]);
    return [["agy", "mcp", "add", ...headers, name, d.url]];
  }
  return null;
}

/** Antigravity counterpart of buildGrokSyncCommands — MCP servers only. Claude plugins
 *  (`agy plugin import`) are out of scope: different format, unverified. */
export function buildAgySyncCommands(_setup: ClaudeSetup, mcpServers: Record<string, unknown> = {}): { cmds: string[][]; skipped: string[] } {
  const cmds: string[][] = [];
  const skipped: string[] = [];
  const merged = { ...BUILTIN_MCP, ...withCoolifyCompatibility(mcpServers) };
  for (const [name, def] of Object.entries(merged).sort(([a], [b]) => a.localeCompare(b))) {
    const c = agyMcpCommands(name, def);
    if (c) cmds.push(...c);
    else skipped.push(name);
  }
  return { cmds, skipped };
}

/** MCP server names from `~/.gemini/config/mcp_config.json` (`{"mcpServers": {...}}`). */
export function parseAgyMcpNames(json: string): string[] {
  try {
    const servers = (JSON.parse(json) as { mcpServers?: unknown })?.mcpServers;
    return servers && typeof servers === "object" ? Object.keys(servers).sort() : [];
  } catch { return []; }
}

// --- Pruning removed servers (agent-sync.ts --prune) ---------------------------
// Sync can only add and overwrite. A server that DISAPPEARED from the catalog stayed
// in the agents' configuration forever — including a token that no longer belongs anywhere. This arm
// therefore reads what is ACTUALLY in the configurations and compares it with the catalog.
//
// Pruning is deliberately opt-in (`--prune`): it deletes foreign configuration, and a single run with
// a locked vault or against the wrong `DEVD_CONFIG_DIR` would otherwise delete everything.
// Without the switch the extras are only listed.

/** MCP server names that SHOULD be in the configuration — built-in plus catalog.
 *  One definition for all three arms so it cannot diverge from `buildSyncCommands`
 *  and friends, which do the merge the same way (`{ ...BUILTIN_MCP, ...mcpServers }`). */
export function desiredMcpNames(mcpServers: Record<string, unknown> = {}): Set<string> {
  return new Set(Object.keys({ ...BUILTIN_MCP, ...mcpServers }));
}

/** MCP server names written in Claude's `.claude.json` (user scope).
 *  Unreadable/missing file → empty, NOT an exception: a fresh volume does not have one yet
 *  and that is not an error. Empty also means "nothing to prune", i.e. the safe direction. */
export function parseClaudeMcpNames(json: string): string[] {
  try {
    const j = JSON.parse(json) as { mcpServers?: Record<string, unknown> } | null;
    return Object.keys(j?.mcpServers ?? {}).sort();
  } catch { return []; }
}

/** MCP server names from the Codex/Grok TOML config.
 *
 *  Takes ONLY first-level tables `[mcp_servers.<name>]` — subtables
 *  (`[mcp_servers.x.http_headers]`, `.env`) must not get into the list, otherwise prune would
 *  try to delete a nonexistent server named "http_headers". Hence `\]` right after the name.
 *
 *  A quoted name is unescaped back (counterpart of `tomlString`) — otherwise a
 *  server with a special character in its name would never match the catalog and prune would
 *  delete it on every run over and over. */
export function parseTomlMcpNames(toml: string): string[] {
  const names: string[] = [];
  const re = /^[ \t]*\[mcp_servers\.(?:"((?:[^"\\]|\\.)*)"|([A-Za-z0-9_-]+))\][ \t]*$/gm;
  for (const m of toml.matchAll(re)) {
    names.push(m[1] !== undefined ? unescapeTomlString(m[1]) : (m[2] ?? ""));
  }
  return [...new Set(names)].sort();
}

function unescapeTomlString(v: string): string {
  const named: Record<string, string> = { "\\": "\\", '"': '"', n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" };
  return v.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_, esc: string) =>
    esc[0] === "u" ? String.fromCharCode(parseInt(esc.slice(1), 16)) : (named[esc] ?? esc));
}

export interface PresentMcpNames { claude: string[]; codex: string[]; grok: string[]; agy: string[] }
export interface PruneRemoval { agent: "claude" | "codex" | "grok" | "agy"; name: string; cmd: string[] }

/** What is in the configuration beyond the catalog, and how to remove it.
 *
 *  The removal commands are deliberately THE SAME ones the idempotent branch of the
 *  sync already uses (`claude mcp remove … -s user`, `codex mcp remove …`), so they
 *  open no new path into the configuration. `grok mcp remove` exists too
 *  (verified on grok 1.0.13) — it is just not used in `grokMcpCommands`, because `add`
 *  is idempotent there on its own. */
export function buildPruneCommands(desired: Set<string>, present: PresentMcpNames): PruneRemoval[] {
  const out: PruneRemoval[] = [];
  const extra = (names: string[]) => names.filter((n) => n && !desired.has(n)).sort();
  for (const name of extra(present.claude)) out.push({ agent: "claude", name, cmd: ["claude", "mcp", "remove", name, "-s", "user"] });
  for (const name of extra(present.codex)) out.push({ agent: "codex", name, cmd: ["codex", "mcp", "remove", name] });
  for (const name of extra(present.grok)) out.push({ agent: "grok", name, cmd: ["grok", "mcp", "remove", name] });
  for (const name of extra(present.agy)) out.push({ agent: "agy", name, cmd: ["agy", "mcp", "remove", name] });
  return out;
}

// --- Safe command logging (agent-sync.ts) ----------------------------------------
// The command `["bash", "-lc", <script>]` is the shape where the token sits in one shell string
// (see the http_headers append above for Codex) — its label and error output must always be
// redacted, not just truncated (truncation would leave the token in the first N characters).
//
// Other commands that carry the token as a separate argv element after `-H`/`--header`/
// `-e`/`--env` (Codex stdio `--env`, Grok stdio `-e`, Grok http `-H`), or as the whole
// definition in one arg (Claude `mcp add-json`), were previously left out of this list —
// on the grounds that the token always sits past position 5, so describeCommand's 5-token
// truncation reliably does not reveal it on the SUCCESS branch (true and verified). But on the
// FAIL branch in agent-sync.ts the raw stdout/stderr of the command is logged, not its truncated
// label — and if the corresponding CLI echoes its arguments back on error (bad URL, name conflict,
// verbose dump…), the token leaks anyway. That is why they are RECOGNISED here as
// secret-bearing too, even though their argv is not a problem on the SUCCESS branch.
//
// Fix round 1 (review): `agy mcp add <name> <url>` WITHOUT headers has no `-H`/`--env`
// flag, so it previously did not fall in here at all — and a URL with a token in the query string
// (`?api_key=…`) thus leaked both in the five-token label (the URL sits at position 4, see
// describeCommand) and in the raw FAIL output. `looksSecret` (previously tied only to
// `add-json`) is therefore checked over ALL commands, not just this one
// subcommand — it also catches a url-with-token for Antigravity without narrowing the existing
// add-json coverage.
export function isSecretBearingCommand(cmd: string[]): boolean {
  if (cmd[0] === "bash" && cmd[1] === "-lc") return true;
  if (cmd.includes("-H") || cmd.includes("--header") || cmd.includes("-e") || cmd.includes("--env")) return true;
  // Finding 2 (review phase 1b): `looksSecret` catches only keywords and query parameters,
  // not secrets hidden in the URL PATH (n8n `/mcp/<uuid>/sse`, Zapier `/s/<key>/mcp`).
  // For `agy mcp add <name> <url>` the URL always sits right after the server name and no other agent
  // (Codex/Grok/Claude) ever has it at position 4, so it is safe to treat EVERY such
  // URL as a secret regardless of content — a narrow fix just for this one shape.
  if (cmd[0] === "agy" && cmd[1] === "mcp" && cmd[2] === "add" && cmd.some((t) => /^https?:\/\//i.test(t))) return true;
  // Blanket redaction was costly: when sync broke, the log only showed "<redacted>" and
  // the cause (actually a harmless "already exists in user config") could only be found by
  // running the command by hand. So we decide by argument content, not by the
  // subcommand name. Errors go to the safe side: anything that looks like a secret is
  // still redacted.
  return cmd.some(looksSecret);
}

/** Is this the "already configured" message, i.e. success on a repeated run?
 *
 *  All three CLIs phrase it differently (`already exists in user config`,
 *  `Marketplace source already configured`, `already installed`) and all return a
 *  nonzero code, so the second sync run looked like 21 failures.
 *
 *  The patterns are deliberately NARROW and tied to the word "already": a broader match (say a bare
 *  "exists") could swallow a real error and turn a broken sync into a
 *  silent success — which is worse than today's noise. Unknown wording stays a failure. */
export function alreadyConfigured(output: string): boolean {
  return /already (exists|configured|installed|added)/i.test(output);
}

/** Does the argument carry a secret? Keys, not values — a value can be anything, but
 *  an MCP server definition names where it puts the token (`headers`, `env`), and `token`
 *  also catches shapes these two keys miss.
 *
 *  Fix round 2 (review): `token|secret|api[-_]?key|authorization` does not catch a BARE query
 *  parameter `key=` (Google/Firebase style: `?key=<APIKEY>`), because "key" on its own
 *  is not in the list — only `api[-_]?key`. The added pattern `[?&](api[-_]?)?key=` is however DELIBERATELY
 *  narrow: "key" must sit as a query parameter name (right after `?` or `&`, right before
 *  `=`), not as an arbitrary substring match — otherwise it would start redacting a harmless
 *  server name/hostname like "keycloak" or "monkey". */
function looksSecret(arg: string): boolean {
  return /"(headers|env)"\s*:/.test(arg) ||
    /token|secret|api[-_]?key|authorization/i.test(arg) ||
    /[?&](api[-_]?)?key=/i.test(arg);
}

/** Safe command label for logs (both the ok and FAIL branch in agent-sync.ts). For `bash -lc`
 *  (the token can sit anywhere in the single arg — see above) it returns a fixed placeholder. For
 *  other secret-bearing commands it returns a safe prefix with the suffix "<redacted>" — so it is
 *  still possible to tell WHICH command failed, just not with what value. For other commands it
 *  keeps the existing behaviour (first 5 tokens unchanged).
 *
 *  For Codex/Grok the secret value ALWAYS sits past position 5 (the server name comes first,
 *  then `--env`/`-e`/`-H`), so taking the first 5 tokens unchanged was enough there. Antigravity
 *  (`agy mcp add --header "K: V" name url`), however, carries flags BEFORE the name — the value would
 *  thus fit right into the five-token prefix. For secret-bearing commands the prefix therefore ends
 *  right BEFORE the first thing that could reveal the value: either the first occurrence of
 *  `-e`/`--env`/`-H`/`--header` (Antigravity with a header/env), or the first argument
 *  that itself looks like a secret according to `looksSecret` (Antigravity WITHOUT headers —
 *  `agy mcp add <name> <url>` — where the token can sit right in the URL, see fix round 1), or
 *  the first argument that looks like an http(s) URL (Finding 2 — a secret hidden in the PATH,
 *  not just in the query string or a keyword, see `isSecretBearingCommand`), or at
 *  position 5, whichever is closer. The server name BEFORE this point stays visible in the
 *  label (it is not secret), only the value after it is replaced with "<redacted>". */
export function describeCommand(cmd: string[]): string {
  if (cmd[0] === "bash" && cmd[1] === "-lc") return "bash -lc <redacted>";
  if (!isSecretBearingCommand(cmd)) return cmd.slice(0, 5).join(" ");
  const flagIndex = cmd.findIndex((t) => t === "-e" || t === "--env" || t === "-H" || t === "--header");
  const secretArgIndex = cmd.findIndex((t) => looksSecret(t));
  const urlArgIndex = cmd.findIndex((t) => /^https?:\/\//i.test(t));
  const cut = Math.min(5, ...[flagIndex, secretArgIndex, urlArgIndex].filter((i) => i >= 0));
  const prefix = cmd.slice(0, cut).join(" ");
  return `${prefix} <redacted>`;
}
