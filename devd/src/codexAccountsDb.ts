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
  db.query(`INSERT OR IGNORE INTO codex_accounts (id,label,status,added_at) VALUES ('default','Main account','ready',0)`).run();
  db.query(`INSERT OR IGNORE INTO codex_account_settings VALUES (1,NULL)`).run();
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
