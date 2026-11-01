import { Database } from "bun:sqlite";
import { repairCodexStats, validateCodexRepairSources } from "../devd/src/codexStatsRepair";

const [dbPath, manifestPath, mode] = process.argv.slice(2);
if (!dbPath || !manifestPath || (mode !== undefined && mode !== "--apply")) {
  throw new Error("Usage: bun tools/codex-stats-repair.ts DATABASE MANIFEST [--apply] (default: read-only)");
}
const apply = mode === "--apply";
const manifest = await Bun.file(manifestPath).json();
validateCodexRepairSources(manifest, process.env.CODEX_REPAIR_SESSIONS ?? "/var/lib/docker/volumes/codex-home/_data/sessions");
const db = new Database(dbPath, apply ? { readwrite: true, create: false } : { readonly: true });
db.exec("PRAGMA busy_timeout=10000");
try { console.log(JSON.stringify(repairCodexStats(db, manifest, apply), null, 2)); }
finally { db.close(); }
