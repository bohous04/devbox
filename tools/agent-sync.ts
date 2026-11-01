#!/usr/bin/env bun
// Applies claude-setup.json + secrets.mcpServers to the shared claude-home, codex-home and
// grok-home volumes by running claude/codex/grok CLI commands in one-off containers from the dev image.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { alreadyConfigured, buildAgySyncCommands, buildCodexSyncCommands, buildGrokSyncCommands, buildPruneCommands, buildSyncCommands, describeCommand, desiredMcpNames, isSecretBearingCommand, parseAgyMcpNames, parseClaudeMcpNames, parseTomlMcpNames, type ClaudeSetup } from "../devd/src/claudeSetup";
import { loadSecrets, readMcpServers } from "../devd/src/config";
import { sh } from "../cli/src/sh";

const configDir = process.env.DEVD_CONFIG_DIR ?? "/etc/devd/config";
const secretsPath = process.env.DEVD_SECRETS ?? "/etc/devd/secrets.json";
// Bridge from devd — must match DEVD_AGENT_SECRETS in devd/src/index.ts.
const agentSecretsPath = process.env.DEVD_AGENT_SECRETS ?? "/etc/devd/agent-secrets.json";
const image = process.env.DEVD_IMAGE ?? "devbox:latest";
const ghConfigDir = process.env.DEVD_GH_CONFIG_DIR ?? "/root/.config/gh";
// Pruning of servers that disappeared from the catalog. Opt-in on purpose — see the comment
// at buildPruneCommands in claudeSetup.ts.
const prune = process.argv.includes("--prune");

const setup = JSON.parse(readFileSync(join(configDir, "claude-setup.json"), "utf8")) as ClaudeSetup;

// MCP servers: primarily from the bridge devd writes after the vault is unlocked (see
// materializeMcpServers). This tool runs as a separate process and cannot see into the
// vault — after the switch to the vault its `secrets.json` vanished from under it, and since then
// it silently synced only marketplaces and plugins. `loadSecrets` on a missing
// file returns empty without an error, so it never surfaced anywhere.
//
// The fallback to secrets.json stays for installs without a vault, where it is still the source.
const bridged = readMcpServers(agentSecretsPath);
const baseMcpServers = Object.keys(bridged).length > 0
  ? bridged
  : ((loadSecrets(secretsPath).mcpServers as Record<string, unknown> | undefined) ?? {});
// Host-local integrations must survive vault hydration and catalog pruning.
const localMcpPath = process.env.DEVD_MCP_LOCAL ?? "/etc/devd/mcp-local.json";
const localMcp = readMcpServers(localMcpPath);
const mcpServers = { ...baseMcpServers, ...localMcp };
if (Object.keys(mcpServers).length === 0) {
  console.error("WARNING: no MCP servers to propagate — unlock the vault in the dashboard and run again.");
}
const cmds = buildSyncCommands(setup, mcpServers);

const codex = buildCodexSyncCommands(setup, mcpServers);
if (codex.skipped.length) console.error(`WARNING: skipped for Codex (untranslatable definition): ${codex.skipped.join(", ")}`);

const grok = buildGrokSyncCommands(setup, mcpServers);
if (grok.skipped.length) console.error(`WARNING: skipped for Grok (untranslatable definition): ${grok.skipped.join(", ")}`);
// Deliberately uninstalled plugins are reported separately and in a milder tone than WARNING: this is
// not a sync defect, but the fact that Grok cannot install them (see grokCannotInstall).
if (grok.skippedPlugins.length) console.error(`Grok — plugins left out: ${grok.skippedPlugins.join("; ")}`);

const agy = buildAgySyncCommands(setup, mcpServers);
if (agy.skipped.length) console.error(`WARNING: skipped for Antigravity (untranslatable definition): ${agy.skipped.join(", ")}`);

// Marketplaces in PRIVATE repos need GitHub git auth inside the container. When the host's
// gh config is present, mount it (:ro) and run `gh auth setup-git` before each claude command
// so git clones can authenticate; otherwise fall back to the bare invocation.
const gh = existsSync(join(ghConfigDir, "hosts.yml"));
const ghMount = gh ? ["-v", `${ghConfigDir}:/home/dev/.config/gh:ro`] : [];
const wrap = (cmd: string[]) =>
  gh ? ["bash", "-c", 'gh auth setup-git >/dev/null 2>&1 || true; exec "$@"', "bash", ...cmd] : cmd;

// We always mount all volumes for all arms — simpler than distinguishing by
// command, and it does not matter that the claude container also sees the (unused) codex-home/grok-home and vice versa.
const mounts = ["-v", "claude-home:/home/dev/.claude", "-v", "codex-home:/home/dev/.codex", "-v", "grok-home:/home/dev/.grok", "-v", "antigravity-home:/home/dev/.gemini"];
const all = [...cmds, ...codex.cmds, ...grok.cmds, ...agy.cmds];
let failed = 0;
let already = 0;
for (const cmd of all) {
  const r = sh(process.cwd(), "docker", "run", "--rm", ...mounts, ...ghMount, image, ...wrap(cmd));
  const label = describeCommand(cmd);
  if (r.code === 0) console.log(`ok:   ${label}`);
  else if (alreadyConfigured(`${r.stderr}\n${r.stdout}`)) {
    // A repeated run is not an error. These CLIs return a non-zero code for "add what is already there",
    // so the second sync run reported 21 "failures" and exited non-zero — the install
    // then reported it as "agent-sync failed" and a REAL failure got lost in that noise.
    already++;
    console.log(`already: ${label}`);
  }
  else {
    failed++;
    // A secret-bearing command (http_headers append, mcp add-json, mcp add --env/-e/-H) must
    // not be printed even via stderr/stdout — they could contain the command text (and thus the
    // token) back if the CLI echoed its arguments on error; shortening the label
    // is not enough on its own.
    const detail = isSecretBearingCommand(cmd) ? "<redacted — the command may carry a token>" : (r.stderr || r.stdout).trim().slice(0, 400);
    console.error(`FAIL: ${label}\n${detail}`);
  }
}
// --- Pruning servers that are no longer in the catalog ------------------------------------
// Only AFTER the sync: if prune ran first, it would also remove a server that this run
// adds back right after, and one failure in the middle would leave it gone for good.
//
// State is read from the ACTUAL configurations in the volumes, not from what the sync just sent —
// the surplus is exactly what no current command mentioned.
const CLAUDE_CFG = "/home/dev/.claude/.claude.json";
const CODEX_CFG = "${CODEX_HOME:-$HOME/.codex}/config.toml";
const GROK_CFG = "$HOME/.grok/config.toml";
const AGY_CFG = "$HOME/.gemini/config/mcp_config.json";
const SEP = "@@@devd-agent-sync@@@";
const dump = sh(process.cwd(), "docker", "run", "--rm", ...mounts, image, "bash", "-lc",
  `for f in "${CLAUDE_CFG}" "${CODEX_CFG}" "${GROK_CFG}" "${AGY_CFG}"; do echo "${SEP}"; cat "$f" 2>/dev/null; done`);
if (dump.code !== 0) {
  console.error("WARNING: could not read the configuration state — surplus MCP servers not checked");
} else {
  const [, claudeCfg = "", codexCfg = "", grokCfg = "", agyCfg = ""] = dump.stdout.split(`${SEP}\n`);
  const removals = buildPruneCommands(desiredMcpNames(mcpServers), {
    claude: parseClaudeMcpNames(claudeCfg),
    codex: parseTomlMcpNames(codexCfg),
    grok: parseTomlMcpNames(grokCfg),
    agy: parseAgyMcpNames(agyCfg),
  });
  if (!removals.length) console.log("surplus MCP servers: none");
  else if (Object.keys(mcpServers).length === 0) {
    // Safeguard against the worst case: an empty catalog (locked vault, wrong
    // DEVD_CONFIG_DIR) would declare absolutely everything surplus and wipe the configuration
    // to nothing. Without a catalog nothing is ever pruned, not even with --prune.
    console.error(`WARNING: ${removals.length} servers look like surplus, but the catalog is empty — not pruning. Unlock the vault and run again.`);
  } else {
    const list = removals.map((r) => `${r.agent}:${r.name}`).join(", ");
    if (!prune) console.log(`surplus MCP servers (run with --prune to remove them): ${list}`);
    else {
      console.log(`pruning ${removals.length}: ${list}`);
      for (const r of removals) {
        const res = sh(process.cwd(), "docker", "run", "--rm", ...mounts, image, ...r.cmd);
        if (res.code === 0) console.log(`ok:   ${r.agent} mcp remove ${r.name}`);
        else { failed++; console.error(`FAIL: ${r.agent} mcp remove ${r.name}\n${(res.stderr || res.stdout).trim().slice(0, 400)}`); }
      }
    }
  }
}

// Agent configurations carry MCP tokens in plaintext and live in SHARED volumes
// (claude-home / codex-home / grok-home / antigravity-home are mounted into every
// session), so their permissions decide who inside the container can read them. Claude and Codex
// create the file with 0600, but `grok mcp add` writes 0644 — i.e. world-readable even outside
// uid 1000, which the agent runs as — and so does `agy mcp add` (measured 2026-10-15).
// We fix it up after them; the chmod inside each of those CLIs cannot be influenced. Found
// 2026-09-04, also confirmed by the other side as the worst of the current exposures.
//
// This does not solve the main problem — the tokens are still in those files and the agent has
// access to them. It only closes needlessly broad permissions, not access itself.
const hardenPaths = ["/home/dev/.grok/config.toml", "/home/dev/.codex/config.toml", "/home/dev/.claude/.claude.json", "/home/dev/.gemini/config/mcp_config.json"];
const harden = sh(process.cwd(), "docker", "run", "--rm", ...mounts, image,
  "bash", "-lc", `chmod 600 ${hardenPaths.join(" ")} 2>/dev/null; ls -l ${hardenPaths.join(" ")}`);
if (harden.code === 0) {
  const loose = harden.stdout.split("\n").filter((l) => l.trim() && !l.startsWith("-rw-------"));
  console.log(loose.length ? `WARNING: could not tighten configurations to 0600:\n${loose.join("\n")}` : "configuration permissions: 0600 ✓");
} else {
  console.error("WARNING: configuration permission check failed — tokens may stay world-readable");
}

console.log(`${all.length - failed}/${all.length} commands succeeded (${already} already configured)`);
process.exit(failed > 0 ? 1 : 0);
