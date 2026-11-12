import type { Database } from "bun:sqlite";
import type { CodexUsageRow } from "./db";

export interface CodexAccountRow {
  id: string; label: string; disabled: number; status: "pending" | "ready" | "error";
  identity: string | null; added_at: number; usage_json: string | null;
}

// Metadata and measurements only. Credentials remain in Docker volumes.
export function initCodexAccounts(db: Database): void {
  db.run(`CREATE TABLE IF NOT EXISTS codex_accounts (
    id TEXT PRIMARY KEY, label TEXT NOT NULL, disabled INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL, identity TEXT, added_at INTEGER NOT NULL, usage_json TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS codex_account_settings (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1), preferred_account_id TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS codex_account_reauth (
    account_id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL, identity TEXT,
    started_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', error TEXT
  )`);
  // The operator can remove the main account for good (e.g. its plan lapsed); the marker keeps
  // this init from recreating it on every start. Older databases lack the column.
  const cols = db.query("PRAGMA table_info(codex_account_settings)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "default_removed"))
    db.run("ALTER TABLE codex_account_settings ADD COLUMN default_removed INTEGER NOT NULL DEFAULT 0");
  db.query(`INSERT OR IGNORE INTO codex_account_settings (singleton,preferred_account_id) VALUES (1,NULL)`).run();
  if (!codexDefaultRemoved(db))
    db.query(`INSERT OR IGNORE INTO codex_accounts (id,label,status,added_at) VALUES ('default','Main account','ready',0)`).run();
}

/** True once the operator removed the main account (`codex-home`); it is then never recreated. */
export function codexDefaultRemoved(db: Database): boolean {
  try {
    const row = db.query("SELECT default_removed FROM codex_account_settings WHERE singleton=1").get() as { default_removed: number } | null;
    return row?.default_removed === 1;
  } catch { return false; }   // registry not initialized yet (no table/column) → nothing was removed
}

export function listCodexAccounts(db: Database): CodexAccountRow[] {
  return db.query("SELECT * FROM codex_accounts ORDER BY added_at,id").all() as CodexAccountRow[];
}
export function getCodexAccount(db: Database, id: string): CodexAccountRow | null {
  return db.query("SELECT * FROM codex_accounts WHERE id=?").get(id) as CodexAccountRow | null;
}
export function codexPreference(db: Database): string | null {
  return (db.query("SELECT preferred_account_id FROM codex_account_settings WHERE singleton=1").get() as { preferred_account_id: string | null }).preferred_account_id;
}
export function storedCodexAccountUsage(db: Database, id: string): CodexUsageRow | null {
  const raw = getCodexAccount(db, id)?.usage_json;
  if (!raw) return null;
  try { return JSON.parse(raw) as CodexUsageRow; } catch { return null; }
}
