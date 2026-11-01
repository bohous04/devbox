import { randomBytes } from "node:crypto";
import type { Database } from "bun:sqlite";

// A placeholder is worthless outside this box: it is valid only for the session it was issued to, and
// the real token is paired with it only in gitProxy from the unlocked vault. If it leaks into a log,
// commit or prompt, an attacker cannot open anything with it.
//
// Kept in SQLite, not just in memory: placeholders must survive a devd restart. While they were only
// in memory, every restart (even an ordinary deploy) broke git in all running sessions —
// the container had a placeholder in its file that devd no longer knew, and got 403.
export interface PlaceholderRef { instance: string; session: string }

export interface PlaceholderStore {
  issue(session: string, instance: string): string;
  lookup(placeholder: string): PlaceholderRef | undefined;
  /** Invalidates all placeholders of a session — called when the session ends. */
  revoke(session: string): void;
  /** The shape gitProxy expects: placeholder → where it belongs. */
  all(): Record<string, PlaceholderRef>;
}

export function createPlaceholderStore(db: Database): PlaceholderStore {
  return {
    issue(session, instance) {
      // Session in the name: the audit and the Gitea log then show whose it was.
      const p = `devbox-${session}-${randomBytes(12).toString("hex")}`;
      db.query("INSERT INTO git_placeholders (placeholder, session_id, instance, created_at) VALUES (?,?,?,?)")
        .run(p, session, instance, Date.now());
      return p;
    },
    lookup(p) {
      const row = db.query("SELECT session_id, instance FROM git_placeholders WHERE placeholder = ?")
        .get(p) as { session_id: string; instance: string } | null;
      return row ? { session: row.session_id, instance: row.instance } : undefined;
    },
    revoke(session) {
      db.query("DELETE FROM git_placeholders WHERE session_id = ?").run(session);
    },
    all() {
      const rows = db.query("SELECT placeholder, session_id, instance FROM git_placeholders")
        .all() as { placeholder: string; session_id: string; instance: string }[];
      return Object.fromEntries(rows.map((r) => [r.placeholder, { session: r.session_id, instance: r.instance }]));
    },
  };
}
