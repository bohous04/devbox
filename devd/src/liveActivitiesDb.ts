import type { Database } from "bun:sqlite";

export type LiveEnvironment = "sandbox" | "production";
export interface LiveDevice {
  device_id: string; server_id: string; enabled: number; start_token: string | null;
  environment: LiveEnvironment | null; activity_id: string | null; update_token: string | null;
  pending_start_at: number | null; last_timestamp: number; last_sent_at: number;
  last_fingerprint: string | null; terminal_since: number | null; retry_after: number;
}
export function migrateLiveActivities(db: Database): void {
  db.run(`CREATE TABLE IF NOT EXISTS live_activity_devices (
    device_id TEXT PRIMARY KEY, server_id TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
    start_token TEXT, environment TEXT, activity_id TEXT, update_token TEXT,
    pending_start_at INTEGER, last_timestamp INTEGER NOT NULL DEFAULT 0,
    last_sent_at INTEGER NOT NULL DEFAULT 0, last_fingerprint TEXT,
    terminal_since INTEGER, retry_after INTEGER NOT NULL DEFAULT 0
  )`);
  // Separate from mutable token registrations: cold launches must recognize an
  // automatic end even after the activity token was retired or replaced.
  db.run(`CREATE TABLE IF NOT EXISTS live_activity_server_ends (
    device_id TEXT NOT NULL, server_id TEXT NOT NULL, activity_id TEXT NOT NULL,
    intended_at INTEGER NOT NULL,
    PRIMARY KEY(device_id,server_id,activity_id)
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS live_activity_server_ends_age ON live_activity_server_ends(intended_at)`);
}

/** Persist before dispatch. iOS can observe immediate dismissal and ask us while
 * the APNs request is still awaiting its response, without ever emitting .ended. */
export function recordLiveActivityServerEnd(db: Database, deviceId: string, serverID: string, activityId: string, at: number): void {
  db.transaction(() => {
    db.query("DELETE FROM live_activity_server_ends WHERE intended_at<?").run(at - 7 * 24 * 60 * 60_000);
    db.query(`INSERT INTO live_activity_server_ends(device_id,server_id,activity_id,intended_at)
      VALUES(?,?,?,?) ON CONFLICT(device_id,server_id,activity_id) DO NOTHING`).run(deviceId,serverID,activityId,at);
  })();
}

export function wasLiveActivityServerEnded(db: Database, deviceId: string, serverID: string, activityId: string): boolean {
  return db.query(`SELECT 1 FROM live_activity_server_ends WHERE device_id=? AND server_id=? AND activity_id=?`)
    .get(deviceId,serverID,activityId) !== null;
}
export function listLiveDevices(db: Database): LiveDevice[] {
  return db.query("SELECT * FROM live_activity_devices WHERE enabled=1").all() as LiveDevice[];
}
export interface LiveRegistration {
  deviceId: string; serverID: string; kind: "start" | "update"; token: string;
  activityId?: string; environment?: LiveEnvironment; optIn?: boolean;
}
export function registerLiveDevice(db: Database, r: LiveRegistration): boolean {
  const old = db.query("SELECT * FROM live_activity_devices WHERE device_id=?").get(r.deviceId) as LiveDevice | null;
  // An in-flight token callback after dismissal must not silently opt back in.
  if (old && !old.enabled && r.kind === "update" && !r.optIn) return false;
  db.query(`INSERT INTO live_activity_devices(device_id,server_id,environment) VALUES(?,?,?)
    ON CONFLICT(device_id) DO UPDATE SET server_id=excluded.server_id,
    environment=COALESCE(excluded.environment,live_activity_devices.environment)`).run(r.deviceId, r.serverID, r.environment ?? null);
  if (r.kind === "start") {
    db.query("UPDATE live_activity_devices SET enabled=1,start_token=? WHERE device_id=?").run(r.token.toLowerCase(),r.deviceId);
  } else {
    const sameActivity = old?.activity_id === r.activityId;
    db.query(`UPDATE live_activity_devices SET enabled=1,activity_id=?,update_token=?,pending_start_at=NULL,
      last_fingerprint=CASE WHEN ? THEN last_fingerprint ELSE NULL END,
      last_sent_at=CASE WHEN ? THEN last_sent_at ELSE 0 END WHERE device_id=?`)
      .run(r.activityId!,r.token.toLowerCase(),sameActivity ? 1 : 0,sameActivity ? 1 : 0,r.deviceId);
  }
  return true;
}
export function disableLiveDevice(db: Database, id: string): void {
  db.query(`UPDATE live_activity_devices SET enabled=0,start_token=NULL,update_token=NULL,activity_id=NULL,
    pending_start_at=NULL,last_fingerprint=NULL,last_sent_at=0,terminal_since=NULL,retry_after=0 WHERE device_id=?`).run(id);
}
export function retireLiveActivity(db: Database, id: string, activityId: string): void {
  const row = db.query("SELECT server_id FROM live_activity_devices WHERE device_id=? AND activity_id=?")
    .get(id,activityId) as { server_id: string } | null;
  if (!row) return;
  // iOS may retire the token while the server's end request is still awaiting
  // APNs. A known automatic end must leave the next turn free to start; only an
  // unrecognized dismissal blocks the current episode from restarting itself.
  const serverEnded = wasLiveActivityServerEnded(db,id,row.server_id,activityId);
  db.query(`UPDATE live_activity_devices SET update_token=NULL,activity_id=NULL,
    pending_start_at=CASE WHEN ? THEN NULL ELSE COALESCE(pending_start_at,?) END,
    last_fingerprint=NULL WHERE device_id=? AND server_id=? AND activity_id=?`)
    .run(serverEnded ? 1 : 0,Date.now(),id,row.server_id,activityId);
}
