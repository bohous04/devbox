import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { STUCK_MS, type AgentEventHub } from "./agentEvents";
import { listSessions } from "./db";
import { recordLiveActivityServerEnd, wasLiveActivityServerEnded, listLiveDevices, registerLiveDevice, disableLiveDevice, retireLiveActivity, type LiveRegistration, type LiveDevice } from "./liveActivitiesDb";
import { sendLiveActivityApns, type ApnsConfig, type ApnsSendDeps, type LiveActivityPush } from "./apns";
import { deriveActivityV2, needsHighPriority, type ActivitySessionInput, type ActivityStateV2 } from "./liveActivityState";
import { specFor } from "./agents";

/** The activity ends 90 s after no session is left that is waiting / working / stalled. */
const END_GRACE_MS = 90_000;
const HEARTBEAT_MS = 45_000;
const COALESCE_MS = 1_000;
interface LiveDeps {
  db: Database; hub: AgentEventHub; config: ApnsConfig | null;
  now?: () => number; run: ApnsSendDeps["run"];
  send?: typeof sendLiveActivityApns;
}
export class LiveActivities {
  private ticking = false;
  private requested = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private changedAtMax = 0;
  constructor(private d: LiveDeps) {}
  get canPush(): boolean { return this.d.config !== null; }
  private now() { return this.d.now?.() ?? Date.now(); }

  /** ContentState v2 from all RUNNING sessions; finished ones count as long as the session is running. */
  state(): ActivityStateV2 { return this.snapshot().content; }

  /** `live` = sessions that keep the activity open: waiting / working / stalled for less
   *  than STUCK_MS. Ones stalled longer (crashed agent, Esc without a hook) are still shown, but no longer
   *  keep the activity open — otherwise it would hang around for hours after the work ended. */
  private snapshot(): { content: ActivityStateV2; live: number } {
    const now = this.now();
    const sessions: ActivitySessionInput[] = [];
    let holding = 0;
    for (const row of listSessions(this.d.db)) {
      if (row.status !== "running") continue;
      const live = this.d.hub.liveSnapshot(row.id);
      const input: ActivitySessionInput = {
        id: row.id, title: row.name || `${row.project}/${row.repo}`, agent: specFor(row.agent).short,
        project: `${row.project}/${row.repo}`, status: live?.status ?? "unknown", reason: live?.reason ?? null,
        // Without the snapshot created_at, not last_active_at — that one changes and would break the heartbeat fingerprint.
        since: live?.statusSince ?? row.created_at,
      };
      sessions.push(input);
      if (input.status === "waiting" || input.status === "working") holding++;
      else if ((input.status === "stalled" || input.status === "failed") && now - input.since < STUCK_MS) holding++;
    }
    const content = deriveActivityV2(sessions, now);
    // changedAt never goes backwards: the departure of the most recently changed session would otherwise move it back.
    this.changedAtMax = Math.max(this.changedAtMax, Date.parse(content.changedAt));
    content.changedAt = new Date(this.changedAtMax).toISOString();
    return { content, live: holding };
  }

  /** Coalesces event bursts; interval reconciliation also handles stall/end transitions and SSH expiry. */
  request(): void {
    this.requested = true;
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick().catch(() => console.warn("live activities: reconciliation failed"));
    }, COALESCE_MS);
    this.timer.unref?.();
  }

  async tick(): Promise<void> {
    if (this.ticking || !this.d.config) return;
    this.ticking = true;
    this.requested = false;
    try {
      const { content, live } = this.snapshot();
      const { updatedAt: _heartbeat, ...stable } = content;
      const fingerprint = JSON.stringify(stable);
      for (const candidate of listLiveDevices(this.d.db)) {
        // A previous device's APNs request yielded to token registration/disable routes.
        // Refresh immediately before this send, not only when committing the result.
        const row = this.d.db.query("SELECT * FROM live_activity_devices WHERE device_id=? AND enabled=1")
          .get(candidate.device_id) as LiveDevice | null;
        if (!row) continue;
        const now = this.now();
        if (row.retry_after > now) continue;
        const terminalSince = live > 0 ? null : (row.terminal_since ?? now);
        this.d.db.query("UPDATE live_activity_devices SET terminal_since=? WHERE device_id=?").run(terminalSince,row.device_id);
        const end = terminalSince !== null && now - terminalSince >= END_GRACE_MS;
        let event: LiveActivityPush["event"];
        let token: string;
        if (row.update_token && row.activity_id) {
          if (!end && fingerprint === row.last_fingerprint && now - row.last_sent_at < HEARTBEAT_MS) continue;
          if (!end && now - row.last_sent_at < COALESCE_MS) continue;
          event = end ? "end" : "update";
          token = row.update_token;
        } else {
          if (end) {
            // A new episode may start later; never bounce while the current episode is still live.
            this.d.db.query("UPDATE live_activity_devices SET pending_start_at=NULL WHERE device_id=?").run(row.device_id);
          }
          if (live === 0 || !row.start_token || row.pending_start_at !== null) continue;
          event = "start";
          token = row.start_token;
          // Persist BEFORE network IO. A process crash/ambiguous transport failure cannot duplicate a start.
          this.d.db.query("UPDATE live_activity_devices SET pending_start_at=? WHERE device_id=?").run(now,row.device_id);
        }
        if (event === "end") recordLiveActivityServerEnd(this.d.db, row.device_id, row.server_id, row.activity_id!, now);
        const timestamp = Math.max(Math.floor(now / 1000), row.last_timestamp + 1);
        this.d.db.query("UPDATE live_activity_devices SET last_timestamp=? WHERE device_id=?").run(timestamp,row.device_id);
        const cfg = { ...this.d.config, ...(row.environment ? { sandbox: row.environment === "sandbox" } : {}) };
        const result = await (this.d.send ?? sendLiveActivityApns)(
          { run: this.d.run, now: () => this.now() }, cfg, token,
          { event, timestamp, contentState: content, serverID: row.server_id,
            priority: event === "update" && !needsHighPriority(lastSent(row.last_fingerprint), content) ? 5 : 10,
            staleDate: timestamp + 90, ...(end ? { dismissalDate: timestamp } : {}) },
        );
        // Token callbacks/disable requests can arrive while APNs is in flight. Never overwrite a newer registration.
        const condition = event === "start" ? "start_token=? AND server_id=? AND enabled=1" : "update_token=? AND activity_id=? AND server_id=? AND enabled=1";
        const identity = event === "start" ? [token, row.server_id] : [token, row.activity_id!, row.server_id];
        if (result === "ok") {
          this.d.db.query(`UPDATE live_activity_devices SET last_sent_at=?,last_fingerprint=?,retry_after=0
            ${end ? ",update_token=NULL,activity_id=NULL,pending_start_at=NULL" : ""}
            WHERE device_id=? AND ${condition}`).run(now,fingerprint,row.device_id,...identity);
        } else if (result === "gone") {
          this.d.db.query(`UPDATE live_activity_devices SET ${event === "start" ? "start_token=NULL" : "update_token=NULL,activity_id=NULL,pending_start_at=" + now}
            WHERE device_id=? AND ${condition}`).run(row.device_id,...identity);
        } else {
          // Only definitive rejection (429/5xx) may retry a start; ambiguous errors remain pending.
          this.d.db.query(`UPDATE live_activity_devices SET retry_after=?
            ${event === "start" && result === "retry" ? ",pending_start_at=NULL" : ""}
            WHERE device_id=? AND ${condition}`).run(now + 30_000,row.device_id,...identity);
        }
      }
    } finally {
      this.ticking = false;
      if (this.requested) this.request();
    }
  }
}

/** Last successfully sent device state (fingerprint = state without updatedAt); v1 → null. */
function lastSent(fingerprint: string | null): ActivityStateV2 | null {
  if (!fingerprint) return null;
  try {
    const parsed = JSON.parse(fingerprint) as Partial<ActivityStateV2>;
    return parsed.version === 2 ? parsed as ActivityStateV2 : null;
  } catch { return null; }
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const opaque = /^[A-Za-z0-9_.:-]{1,128}$/;
export function liveActivitiesRoutes(db: Database, service?: LiveActivities): Hono {
  const app = new Hono();
  app.get("/state", (c) => {
    c.header("Cache-Control", "no-store");
    return service ? c.json(service.state()) : c.json({ error: "Live Activities are not available" },503);
  });
  app.post("/register", async (c) => {
    if (!service || !service.canPush) return c.json({ error: "Background Live Activity delivery is not available" },503);
    if (Number(c.req.header("content-length") ?? 0) > 8192) return c.json({ error: "Request too large" },400);
    const body = await c.req.json().catch(() => null) as Partial<LiveRegistration> | null;
    if (!body || typeof body.deviceId !== "string" || !uuid.test(body.deviceId)
      || typeof body.serverID !== "string" || !opaque.test(body.serverID)
      || !["start", "update"].includes(body.kind ?? "")
      || typeof body.token !== "string" || !/^[0-9a-f]{32,1024}$/i.test(body.token)
      || body.token.length % 2 !== 0
      || (body.kind === "update" && (typeof body.activityId !== "string" || !opaque.test(body.activityId)))
      || (body.optIn !== undefined && typeof body.optIn !== "boolean")
      || (body.environment !== undefined && !["sandbox", "production"].includes(body.environment)))
      return c.json({ error: "Invalid Live Activity registration" },400);
    if (!registerLiveDevice(db,body as LiveRegistration)) return c.json({ error: "Live Activities have been turned off" },409);
    service.request();
    return c.json({ ok: true });
  });
  app.get("/:deviceId/:activityId", (c) => {
    c.header("Cache-Control", "no-store");
    const deviceId = c.req.param("deviceId");
    const activityId = c.req.param("activityId");
    const serverID = c.req.query("serverID");
    if (!uuid.test(deviceId) || !opaque.test(activityId) || !serverID || !opaque.test(serverID))
      return c.json({ error: "Invalid Live Activity identity" },400);
    return c.json({ serverEnded: wasLiveActivityServerEnded(db,deviceId,serverID,activityId) });
  });
  app.delete("/:deviceId/:activityId", (c) => {
    retireLiveActivity(db,c.req.param("deviceId"),c.req.param("activityId"));
    return c.json({ ok: true });
  });
  app.delete("/:deviceId", (c) => {
    disableLiveDevice(db,c.req.param("deviceId"));
    return c.json({ ok: true });
  });
  return app;
}
