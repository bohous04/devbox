#!/usr/bin/env bun
// Writes `mcpServers` into devd's encrypted vault and refreshes the bridge for agent-sync.
//
// Why a dedicated tool: the vault is a sealed blob, so MCP servers in it cannot be
// edited with an editor. Without this the configuration in containers drifts from what
// the catalog generates — exactly what happened (one coolify server had a dead URL there).
//
// The passphrase and data go through ONE stream on STDIN: first line = passphrase,
// the rest = JSON with mcpServers. Nothing is passed in argv (visible in `ps`) nor
// stored in a file that would leave a secret behind on disk.
//
// Usage:
//   { printf '%s\n' "$FRAZE"; cat servers.json; } | bun tools/vault-set-mcp.ts
//   bun tools/vault-set-mcp.ts --dry-run      # only shows the diff, writes nothing
//
// After writing, also run `bun tools/agent-sync.ts` so it propagates into the containers.
import { createVault } from "../devd/src/vault";
import { materializeMcpServers } from "../devd/src/config";

const vaultPath = process.env.DEVD_VAULT ?? "/etc/devd/vault.age";
const bridgePath = process.env.DEVD_AGENT_SECRETS ?? "/etc/devd/agent-secrets.json";
const dryRun = process.argv.includes("--dry-run");

const fail = (m: string): never => { console.error(`✗ ${m}`); process.exit(1); };

const input = await new Response(Bun.stdin.stream()).text();
const nl = input.indexOf("\n");
if (nl < 0) fail("expected the passphrase on the first line and JSON below it");
const passphrase = input.slice(0, nl).replace(/\r$/, "");
const payload = input.slice(nl + 1).trim();
if (!passphrase.trim()) fail("empty passphrase");
if (!payload) fail("empty JSON");

// Accepts both: {"mcpServers":{…}} and a bare {…}. The generated claude.mcp.json has the wrapper.
// `parse` returns the value (instead of assigning to a let in try) so TypeScript sees that the
// variable is always initialized — it cannot infer that through a catch calling a never function.
const parse = (): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(payload) as { mcpServers?: Record<string, unknown> };
    return parsed.mcpServers ?? (parsed as Record<string, unknown>);
  } catch (e) { return fail(`input is not valid JSON: ${(e as Error).message}`); }
};
const servers = parse();
if (!servers || typeof servers !== "object" || Array.isArray(servers)) fail("mcpServers must be an object");
if (Object.keys(servers).length === 0) fail("empty server list — that would silently turn MCP off everywhere");

const vault = createVault(vaultPath);
try { vault.unlock(passphrase); }
catch (e) { fail(`could not unlock the vault: ${(e as Error).message}`); }

const before = Object.keys((vault.secrets().mcpServers ?? {}) as Record<string, unknown>).sort();
const after = Object.keys(servers).sort();
const added = after.filter((k) => !before.includes(k));
const removed = before.filter((k) => !after.includes(k));

console.error(`vault: ${before.length} servers → ${after.length}`);
if (added.length) console.error(`  + ${added.join(", ")}`);
if (removed.length) console.error(`  - ${removed.join(", ")}   ← WILL BE REMOVED`);
if (!added.length && !removed.length) console.error("  (same names; only the definitions change)");

if (dryRun) { console.error("\n--dry-run: nothing written"); process.exit(0); }

vault.update((s) => { s.mcpServers = servers; });
materializeMcpServers(bridgePath, servers);
console.error(`\n✓ written to ${vaultPath} and refreshed the bridge ${bridgePath}`);
console.error("  now run: bun tools/agent-sync.ts");
