import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentEventHub } from "../src/agentEvents";
import { insertSession, openDb, type SessionRow } from "../src/db";
import { LiveActivities, liveActivitiesRoutes } from "../src/liveActivities";
import { recordLiveActivityServerEnd, wasLiveActivityServerEnded, disableLiveDevice, listLiveDevices, registerLiveDevice, retireLiveActivity } from "../src/liveActivitiesDb";
import { liveActivityCurlArgs, liveActivityPayload, type LiveActivityPush } from "../src/apns";
import { deriveActivityV2, needsHighPriority, type ActivitySessionInput, type ActivityStateV2 } from "../src/liveActivityState";

const DEVICE = "11111111-1111-4111-8111-111111111111";
const TOKEN = "ab".repeat(32);
const CFG = { keyPath: "/never-read-test-key", keyId: "test", teamId: "test", bundleId: "com.example.devbox", sandbox: false };
function fixture() {
  const db = openDb(":memory:");
  let time = 1_700_000_000_000;
  const row: SessionRow = { id: "dev-shop-cms", folder: "x", project: "shop", repo: "cms", container: "c", port_base: 1000,
    status: "running", solo: 0, created_at: time - 1000, last_active_at: time - 1000, important: 0, agent: "codex" };
  insertSession(db,row);
  const hub = new AgentEventHub({ db, now: () => time, notify: () => {} });
  const sent: { token: string; push: LiveActivityPush; sandbox?: boolean }[] = [];
  let result: "ok" | "gone" | "retry" | "error" = "ok";
  const service = new LiveActivities({ db, hub, now: () => time, config: CFG, run: async () => { throw new Error("No real transport allowed"); },
    send: async (_d,cfg,token,push) => { sent.push({ token,push,sandbox:cfg.sandbox }); return result; } });
  const register = (kind: "start" | "update", deviceId = DEVICE) => registerLiveDevice(db,{ deviceId, serverID: "server-1", kind, token: TOKEN, activityId: "act-1", environment: "sandbox" });
  return { db,row,hub,service,sent,register,now: () => time, advance: (ms:number) => time += ms, result: (r: typeof result) => result = r };
}
const MAIN = { agentSessionId: "main" };
/** State of the single session in the fixture (ContentState v2 has no aggregate status). */
const top = (f: ReturnType<typeof fixture>) => f.service.state().sessions[0]?.status;
const CHILD = { agentSessionId: "child" };

test("restart remains unknown, no start without authoritative work, no fabricated progress", async () => {
  const f = fixture(); f.register("start"); await f.service.tick();
  expect(f.service.state()).toMatchObject({ dot: "idle", counts: { unknown: 1, working: 0 }, sessions: [{ status: "unknown" }] });
  expect(f.sent).toHaveLength(0);
  f.hub.handle(f.row,"user_prompt_submit",MAIN); await f.service.tick();
  expect(f.service.state()).toMatchObject({ dot: "working", counts: { working: 1, unknown: 0 }, sessions: [{ status: "working" }] });
  expect(f.sent[0].push.event).toBe("start");
  const restarted = new AgentEventHub({db:f.db,notify:()=>{}});
  expect(restarted.liveSnapshot(f.row.id)).toBeNull();
});

test("explicit wait dominates stop, child progress and coalescing; owner answer resumes", () => {
  const f = fixture(); f.hub.handle(f.row,"user_prompt_submit",MAIN);
  f.hub.handle(f.row,"tool_start",{...MAIN,toolName:"functions.request_user_input"});
  expect(f.service.state()).toMatchObject({dot:"waiting",counts:{waiting:1}});
  f.hub.handle(f.row,"tool_complete",CHILD);
  f.hub.handle(f.row,"subagent_start",CHILD);
  f.hub.handle(f.row,"stop",MAIN);
  f.advance(25_000); expect(f.hub.sweep()).toEqual([]);
  expect(top(f)).toBe("waiting");
  f.hub.handle(f.row,"permission_request",{...MAIN,toolName:"functions.request_user_input"}); // same wait, coalesced notification
  f.hub.handle(f.row,"tool_complete",{...MAIN,toolName:"functions.request_user_input"});
  expect(top(f)).toBe("working");
});

test("child's explicit wait clears only on that child's own progress", () => {
  const f=fixture(); f.hub.handle(f.row,"user_prompt_submit",MAIN);
  f.hub.handle(f.row,"permission_request",CHILD);
  f.hub.handle(f.row,"tool_complete",MAIN);
  expect(top(f)).toBe("waiting");
  f.hub.handle(f.row,"tool_complete",CHILD);
  expect(top(f)).toBe("working");
});

test("busy subagents and quiet window are retained; completion/end after linger permits a new turn", async () => {
  const f=fixture();f.register("start");f.register("update");
  f.hub.handle(f.row,"user_prompt_submit",MAIN); f.hub.handle(f.row,"subagent_start",CHILD);
  f.hub.handle(f.row,"stop",MAIN); f.advance(30_000); expect(f.hub.sweep()).toEqual([]);
  f.hub.handle(f.row,"subagent_stop",CHILD); f.hub.handle(f.row,"stop",MAIN);
  f.advance(19_000); f.hub.sweep(); expect(top(f)).toBe("working");
  f.advance(1_000); f.hub.sweep(); expect(top(f)).toBe("done");
  await f.service.tick(); expect(f.sent.at(-1)?.push.event).toBe("update");
  f.advance(90_000); await f.service.tick(); expect(f.sent.at(-1)?.push.event).toBe("end");
  await f.service.tick(); expect(f.sent).toHaveLength(2);
  f.hub.handle(f.row,"user_prompt_submit",MAIN); await f.service.tick(); expect(f.sent.at(-1)?.push.event).toBe("start");
});

test("push-to-start guard persists, update replaces token, active heartbeat keeps stale-date fresh", async () => {
  const f=fixture();f.register("start");f.hub.handle(f.row,"user_prompt_submit",MAIN);
  await f.service.tick();f.advance(60_000);await f.service.tick();expect(f.sent).toHaveLength(1);
  expect(listLiveDevices(f.db)[0].pending_start_at).toBeGreaterThan(0);
  f.register("update");await f.service.tick();expect(f.sent.at(-1)?.push.event).toBe("update");
  f.advance(44_000);await f.service.tick();expect(f.sent).toHaveLength(2);
  f.advance(1_000);await f.service.tick();expect(f.sent).toHaveLength(3);
  expect(f.sent[2].push.timestamp).toBeGreaterThan(f.sent[1].push.timestamp);
  expect(f.sent[2].push.staleDate).toBe(f.sent[2].push.timestamp+90);
});

test("independent devices, APNs environment, explicit opt-in and dismissal without resurrection", async () => {
  const f=fixture(); f.register("start"); f.register("update");
  const second="22222222-2222-4222-8222-222222222222"; f.register("start",second);
  f.hub.handle(f.row,"user_prompt_submit",MAIN);await f.service.tick();
  expect(f.sent.map(s=>s.push.event)).toEqual(["update","start"]);expect(f.sent.every(s=>s.sandbox)).toBe(true);
  disableLiveDevice(f.db,DEVICE);expect(f.register("update")).toBe(false);
  expect(registerLiveDevice(f.db,{deviceId:DEVICE,serverID:"server-1",kind:"update",activityId:"act-2",token:TOKEN,optIn:true})).toBe(true);
  retireLiveActivity(f.db,DEVICE,"obsolete-activity");expect(listLiveDevices(f.db).find(d=>d.device_id===DEVICE)?.activity_id).toBe("act-2");
  retireLiveActivity(f.db,DEVICE,"act-2");f.advance(60_000);await f.service.tick();expect(f.sent).toHaveLength(2);
});

test("temporary rejection retries; ambiguous start and gone update cannot duplicate an activity", async () => {
  const f=fixture(); f.register("start"); f.hub.handle(f.row,"user_prompt_submit",MAIN);
  f.result("retry");await f.service.tick();await f.service.tick();expect(f.sent).toHaveLength(1);
  f.advance(30_000);f.result("error");await f.service.tick();expect(f.sent).toHaveLength(2);
  f.advance(60_000);await f.service.tick();expect(f.sent).toHaveLength(2);
  f.register("update");f.result("gone");await f.service.tick();
  f.advance(60_000);await f.service.tick();expect(f.sent).toHaveLength(3);
});

test("failure shows as stalled, interruption is unknown, long silent work becomes stalled", () => {
  const f=fixture(); f.hub.handle(f.row,"user_prompt_submit",MAIN);
  f.hub.handle(f.row,"stop_failure",MAIN); f.hub.handle(f.row,"interrupted",MAIN);expect(top(f)).toBe("stalled");
  f.hub.handle(f.row,"user_prompt_submit",MAIN);f.hub.handle(f.row,"interrupted",MAIN);expect(top(f)).toBe("unknown");
  f.hub.handle(f.row,"user_prompt_submit",MAIN);f.advance(20*60_000+1);expect(top(f)).toBe("stalled");
});

test("APNs push fits 4 KB even with adversarial UTF-8 in every field", async () => {
  const f=fixture();const huge='😄"\\'.repeat(2000);
  const rows: ActivitySessionInput[] = Array.from({length:10},(_,i)=>({id:huge+i,title:huge,agent:huge,project:huge,
    status:(i===9?'waiting':'working') as ActivitySessionInput["status"],reason:i===9?huge:null,since:f.now()}));
  const state=deriveActivityV2(rows,f.now());expect(state).toMatchObject({dot:"waiting",counts:{waiting:1,working:9}});
  expect(JSON.stringify(state)).not.toContain("\uFFFD");
  const push={event:"start" as const,timestamp:123,contentState:state,serverID:"s".repeat(128)};
  const args=liveActivityCurlArgs(CFG,"fake-jwt",TOKEN,push);
  expect(Buffer.byteLength(JSON.stringify(liveActivityPayload(push)))).toBeLessThanOrEqual(4096);
  expect(args).toContain("apns-topic: com.example.devbox.push-type.liveactivity");expect(args).toContain("apns-push-type: liveactivity");
  expect(liveActivityPayload(push).aps).toMatchObject({"attributes-type":"DevboxAgentActivityAttributes",attributes:{serverID:"s".repeat(128)},"input-push-token":1});
});

test("registration API sanitizes responses, rejects malformed tokens and GET shares native contract", async () => {
  const f=fixture();const app=liveActivitiesRoutes(f.db,f.service);
  const send=(body:unknown)=>app.request("http://x/register",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
  const r=await send({deviceId:DEVICE,serverID:"server-1",kind:"start",token:TOKEN});expect(r.status).toBe(200);expect(await r.json()).toEqual({ok:true});
  expect((await send({deviceId:DEVICE,serverID:"server-1",kind:"update",token:TOKEN})).status).toBe(400);
  expect((await send({deviceId:DEVICE,serverID:"server-1",kind:"start",token:"bad{token}"})).status).toBe(400);
  f.hub.handle(f.row,"user_prompt_submit",MAIN);
  const state=await (await app.request("http://x/state")).json() as {version:number;sessions:object[]};expect(state.version).toBe(2);
  const native=await Bun.file(new URL("../../ios/DevboxAppTests/Fixtures/agent-live-activity-v2.json",import.meta.url)).json();
  expect(Object.keys(state.sessions[0]).sort()).toEqual(Object.keys(native.sessions[0]).sort());
  expect(Object.keys(state).sort()).toEqual(Object.keys(native).sort());
  await app.request(`http://x/${DEVICE}`,{method:"DELETE"});expect(listLiveDevices(f.db)).toHaveLength(0);
});

test("waiting tool/call is correlated and stale Grok prompt completion cannot resume a new turn", () => {
  const f=fixture();f.hub.handle(f.row,"user_prompt_submit",{...MAIN,promptId:"new"});
  const wait={...MAIN,promptId:"new",toolName:"mcp__functions__request_user_input",toolCallId:"question-2"};
  f.hub.handle(f.row,"tool_start",{...MAIN,promptId:"new",toolName:"exec_command",toolCallId:"shell-1"});
  f.hub.handle(f.row,"tool_start",wait);
  // A call that was already running when the question appeared is no evidence of an answer.
  f.hub.handle(f.row,"tool_complete",{...MAIN,promptId:"new",toolName:"exec_command",toolCallId:"shell-1"});
  expect(top(f)).toBe("waiting");
  f.hub.handle(f.row,"tool_complete",{...wait,promptId:"old"});expect(top(f)).toBe("waiting");
  f.hub.handle(f.row,"tool_complete",wait);expect(top(f)).toBe("working");
  f.hub.handle(f.row,"stop",{...MAIN,promptId:"new"});f.advance(20_000);f.hub.sweep();
  f.hub.handle(f.row,"tool_complete",{...MAIN,promptId:"new",toolName:"exec_command"});expect(top(f)).toBe("done");
  f.hub.handle(f.row,"tool_start",{...MAIN,promptId:"new",toolName:"exec_command"});expect(top(f)).toBe("working");
});

test("simultaneous child and main waits each require their own answer", () => {
  const f=fixture();f.hub.handle(f.row,"user_prompt_submit",MAIN);
  const mainWait={...MAIN,toolName:"request_user_input",toolCallId:"main-question"};
  const childWait={...CHILD,toolName:"exec_command",toolCallId:"child-permission"};
  f.hub.handle(f.row,"tool_start",mainWait);f.hub.handle(f.row,"permission_request",childWait);
  f.hub.handle(f.row,"tool_complete",childWait);expect(top(f)).toBe("waiting");
  // Main's own later call means main moved on; the child's progress could not clear main's wait.
  f.hub.handle(f.row,"tool_complete",{...CHILD,toolName:"exec_command",toolCallId:"child-other"});expect(top(f)).toBe("waiting");
  f.hub.handle(f.row,"tool_complete",{...MAIN,toolName:"exec_command",toolCallId:"other"});expect(top(f)).toBe("working");
});

test("registration without APNs config returns503 while foreground state remains available",async()=> {
  const f=fixture();const service=new LiveActivities({db:f.db,hub:f.hub,config:null,run:async()=>{throw Error("must not send");}});
  const app=liveActivitiesRoutes(f.db,service);
  expect((await app.request("http://x/state")).status).toBe(200);
  const response=await app.request("http://x/register",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({deviceId:DEVICE,serverID:"server",kind:"start",token:TOKEN})});
  expect(response.status).toBe(503);expect(listLiveDevices(f.db)).toHaveLength(0);
});

test("each device is re-read after prior APNs await: disable and update-token registration prevent stale starts",async()=> {
  for (const action of ["disable","update"] as const) {
    const f=fixture();const second="22222222-2222-4222-8222-222222222222";
    f.register("start");f.register("start",second);f.hub.handle(f.row,"user_prompt_submit",MAIN);
    const sends: string[]=[];
    const service=new LiveActivities({db:f.db,hub:f.hub,config:CFG,now:f.now,run:async()=>{throw Error("fake only");},
      send:async(_d,_cfg,_token,push)=>{
        sends.push(push.event);
        if(sends.length===1) { if(action==="disable") disableLiveDevice(f.db,second);else f.register("update",second); }
        return "ok";
      }});
    await service.tick();expect(sends).toEqual(action==="disable"?["start"]:["start","update"]);
  }
});

test("server end intent is visible to iOS before APNs end returns, without disabling future work",async()=> {
  const f=fixture();f.register("start");f.register("update");
  const app=liveActivitiesRoutes(f.db,f.service);
  const query=()=>app.request(`http://x/${DEVICE}/act-1?serverID=server-1`);
  expect(await (await query()).json()).toEqual({serverEnded:false});
  let release!:()=>void;const pending=new Promise<void>(resolve=>release=resolve);
  const service=new LiveActivities({db:f.db,hub:f.hub,config:CFG,now:f.now,run:async()=>{throw Error("fake only");},
    send:async(_d,_cfg,_token,push)=>{
      if(push.event==="end") {
        expect(await (await query()).json()).toEqual({serverEnded:true});
        await pending;
      }
      return "ok";
    }});
  await service.tick();f.advance(90_000);const ending=service.tick();
  expect(await (await query()).json()).toEqual({serverEnded:true});
  release();await ending;
  expect(listLiveDevices(f.db)[0]).toMatchObject({enabled:1,start_token:TOKEN,activity_id:null});
});

test("server-end disposition survives daemon database reopen and a new registration, isolated by all identities",async()=> {
  const directory=mkdtempSync(join(tmpdir(),"live-end-"));const file=join(directory,"devd.sqlite");let db=openDb(file);
  try {
    recordLiveActivityServerEnd(db,DEVICE,"server-1","act-1",Date.now());
    disableLiveDevice(db,DEVICE);db.close();db=openDb(file);
    registerLiveDevice(db,{deviceId:DEVICE,serverID:"server-2",kind:"update",token:TOKEN,activityId:"act-2"});
    const app=liveActivitiesRoutes(db);
    const request=async(device=DEVICE,server="server-1",activity="act-1")=>(await app.request(`http://x/${device}/${activity}?serverID=${server}`)).json();
    expect(await request()).toEqual({serverEnded:true});
    expect(await request(DEVICE,"server-2")).toEqual({serverEnded:false});
    expect(await request(DEVICE,"server-1","act-2")).toEqual({serverEnded:false});
    expect(await request("22222222-2222-4222-8222-222222222222")).toEqual({serverEnded:false});
    expect((await app.request(`http://x/${DEVICE}/act-1`)).status).toBe(400);
    expect((await app.request("http://x/not-a-device/act-1?serverID=server-1")).status).toBe(400);
    expect((await app.request(`http://x/${DEVICE}/act-1?serverID=bad%20identity`)).status).toBe(400);
  } finally {db.close();rmSync(directory,{recursive:true,force:true});}
});

test("rejected or pending end intent remains queryable; unrelated token expiration never pretends server completion",async()=> {
  const f=fixture();f.register("update");await f.service.tick();f.advance(90_000);f.result("retry");await f.service.tick();
  expect(wasLiveActivityServerEnded(f.db,DEVICE,"server-1","act-1")).toBe(true);
  const other=fixture();other.register("update");other.hub.handle(other.row,"user_prompt_submit",MAIN);other.result("gone");await other.service.tick();
  expect(wasLiveActivityServerEnded(other.db,DEVICE,"server-1","act-1")).toBe(false);
});

test("old server-end intents are pruned on new endings while current intent is retained",()=> {
  const f=fixture();recordLiveActivityServerEnd(f.db,DEVICE,"server-1","old",f.now()-8*24*60*60_000);
  recordLiveActivityServerEnd(f.db,DEVICE,"server-1","current",f.now());
  expect(wasLiveActivityServerEnded(f.db,DEVICE,"server-1","old")).toBe(false);
  expect(wasLiveActivityServerEnded(f.db,DEVICE,"server-1","current")).toBe(true);
});

test("scoped iOS retirement during APNs end cannot block the immediately following real turn",async()=> {
  const f=fixture();f.register("start");f.register("update");const events:string[]=[];
  let release!:()=>void;const pending=new Promise<void>(resolve=>release=resolve);
  let reachedEnd!:()=>void;const endStarted=new Promise<void>(resolve=>reachedEnd=resolve);
  const service=new LiveActivities({db:f.db,hub:f.hub,config:CFG,now:f.now,run:async()=>{throw Error("fake only");},
    send:async(_d,_cfg,_token,push)=>{
      events.push(push.event);
      if(push.event==="end") {reachedEnd();await pending;}
      return "ok";
    }});
  await service.tick();f.advance(90_000);const ending=service.tick();await endStarted;
  expect(wasLiveActivityServerEnded(f.db,DEVICE,"server-1","act-1")).toBe(true);
  retireLiveActivity(f.db,DEVICE,"act-1");
  expect(listLiveDevices(f.db)[0]).toMatchObject({enabled:1,start_token:TOKEN,activity_id:null,pending_start_at:null});
  f.hub.handle(f.row,"user_prompt_submit",MAIN);release();await ending;await service.tick();
  expect(events).toEqual(["update","end","start"]);
});

// ---- ContentState v2 ----
const V2_NOW = Date.parse("2026-10-19T10:00:00.000Z");
const min = (m: number) => V2_NOW - m * 60_000;
type V2In = ActivitySessionInput;
const v2 = (id: string, status: V2In["status"], sinceMin: number, reason: string | null = null, agent = "claude"): V2In =>
  ({ id, title: id.replace("dev-", "").toUpperCase(), agent, project: "portal/web", status, reason, since: min(sinceMin) });
// 13 running sessions: 2 waiting, 1 failed + 1 maybe stalled, 2 working, 1 done, 6 unknown
// → 8 rows cover all five states, overflow 5 (the iOS contract must contain every state).
const V2_INPUT: V2In[] = [
  v2("dev-work-x", "working", 7), v2("dev-unknown-c", "unknown", 60), v2("dev-wait-new", "waiting", 1, "Should I continue with the database migration?"),
  v2("dev-unknown-a", "unknown", 30), v2("dev-wait-old", "waiting", 9, "Approve SSH key: infra-root · root@1.2.3.4:22", "codex"),
  v2("dev-failed", "failed", 4), v2("dev-work-long", "working", 40, null, "grok"),
  v2("dev-stalled", "stalled", 6), v2("dev-unknown-d", "unknown", 70), v2("dev-done", "done", 3),
  v2("dev-unknown-e", "unknown", 80), v2("dev-unknown-f", "unknown", 90), v2("dev-unknown-b", "unknown", 50),
];
// Calm state (idle dot): only done and unknown, no reasons.
const V2_IDLE_INPUT: V2In[] = [v2("dev-done", "done", 12), v2("dev-unknown-a", "unknown", 30), v2("dev-done-b", "done", 2, null, "codex")];

test("v2: counts, dot and order waiting→stalled→working→done→unknown, max 8 with overflow", () => {
  const s = deriveActivityV2(V2_INPUT, V2_NOW);
  expect(s.version).toBe(2);
  expect(s.counts).toEqual({ waiting: 2, working: 2, done: 1, stalled: 2, unknown: 6 });
  expect(s.dot).toBe("waiting");
  expect(s.sessions.map(x => x.id)).toEqual(["dev-wait-old","dev-wait-new","dev-stalled","dev-failed","dev-work-long","dev-work-x","dev-done","dev-unknown-a"]);
  expect(new Set(s.sessions.map(x => x.status))).toEqual(new Set(["waiting","stalled","working","done","unknown"]));
  expect(s.overflow).toBe(5);
  expect(s.sessions.find(x => x.id === "dev-failed")).toMatchObject({ status: "stalled", reason: "Failed with an error" });
  expect(s.sessions.find(x => x.id === "dev-stalled")).toMatchObject({ status: "stalled", reason: "May be stuck" });
  expect(s.sessions[0]).toMatchObject({ status: "waiting", reason: "Approve SSH key: infra-root · root@1.2.3.4:22", since: new Date(min(9)).toISOString(), agent: "codex" });
  expect(s.changedAt).toBe(new Date(min(1)).toISOString());
  expect(s.updatedAt).toBe(new Date(V2_NOW).toISOString());
  const all = deriveActivityV2(V2_INPUT.filter(x => !["waiting"].includes(x.status)), V2_NOW);
  expect(all.dot).toBe("stalled");
  expect(deriveActivityV2(V2_INPUT.filter(x => ["working","done"].includes(x.status)), V2_NOW).dot).toBe("working");
  expect(deriveActivityV2(V2_INPUT.filter(x => ["unknown","done"].includes(x.status)), V2_NOW).dot).toBe("idle");
  // No sessions: deterministic changedAt (otherwise the fingerprint would change every tick).
  expect(deriveActivityV2([], V2_NOW)).toMatchObject({ counts: { waiting: 0, working: 0, done: 0, stalled: 0, unknown: 0 }, dot: "idle", sessions: [], overflow: 0, changedAt: new Date(0).toISOString() });
});

/** The fixture shared with iOS is pinned: it is rewritten only with UPDATE_FIXTURES=1, otherwise missing/different = fail. */
async function expectPinnedFixture(name: string, actual: ActivityStateV2) {
  const file = new URL(`../../ios/DevboxAppTests/Fixtures/${name}`, import.meta.url);
  if (process.env.UPDATE_FIXTURES === "1") await Bun.write(file, JSON.stringify(actual, null, 2) + "\n");
  expect(await Bun.file(file).exists()).toBe(true);
  const stored = await Bun.file(file).json();
  expect(stored).toEqual(JSON.parse(JSON.stringify(actual)));
  expect(Object.keys(stored).sort()).toEqual(["changedAt","counts","dot","overflow","sessions","updatedAt","version"]);
  for (const row of stored.sessions) expect(Object.keys(row).sort()).toEqual(["agent","id","project","reason","since","status","title"]);
  return stored as ActivityStateV2;
}

test("v2 fixtures shared with iOS equal deriveActivityV2 output (ISO dates, exact keys)", async () => {
  const busy = await expectPinnedFixture("agent-live-activity-v2.json", deriveActivityV2(V2_INPUT, V2_NOW));
  expect(busy).toMatchObject({ dot: "waiting", overflow: 5 });
  expect(new Set(busy.sessions.map(x => x.status))).toEqual(new Set(["waiting","stalled","working","done","unknown"]));
  const idle = await expectPinnedFixture("agent-live-activity-v2-idle.json", deriveActivityV2(V2_IDLE_INPUT, V2_NOW));
  expect(idle).toMatchObject({ dot: "idle", overflow: 0, counts: { waiting: 0, working: 0, done: 2, stalled: 0, unknown: 1 } });
  expect(idle.sessions.every(x => x.reason === null)).toBe(true);
});

test("v2: 12 sessions × 140-char reason fit the 4096 B APNs payload, overflow > 0", () => {
  const reason = "Ø".repeat(140);
  const rows = Array.from({ length: 12 }, (_, i) => ({ ...v2(`dev-session-${"x".repeat(100)}-${i}`, "waiting", i, reason), title: "Æ".repeat(120), project: "p".repeat(80) }));
  const state = deriveActivityV2(rows, V2_NOW);
  expect(state.overflow).toBeGreaterThan(0);
  expect(state.counts.waiting).toBe(12);
  expect(state.sessions.length + state.overflow).toBe(12);
  expect(state.sessions.every(s => s.reason === null || Array.from(s.reason).length <= 60)).toBe(true);
  const push = { event: "start" as const, timestamp: 1_800_000_000, contentState: state, serverID: "s".repeat(128), staleDate: 1_800_000_090 };
  expect(Buffer.byteLength(JSON.stringify(liveActivityPayload(push)))).toBeLessThanOrEqual(4096);
  expect(() => liveActivityCurlArgs(CFG, "fake-jwt", TOKEN, push)).not.toThrow();
  // A small state is not trimmed.
  expect(deriveActivityV2(V2_INPUT, V2_NOW).sessions[1].reason).toBe("Should I continue with the database migration?");
});

test("v2: needsHighPriority only when the waiting or stalled set changes", () => {
  const base = deriveActivityV2(V2_INPUT, V2_NOW);
  const with_ = (id: string, status: V2In["status"]) => deriveActivityV2(V2_INPUT.map(x => x.id === id ? { ...x, status, since: V2_NOW } : x), V2_NOW + 1000);
  expect(needsHighPriority(base, with_("dev-work-x", "waiting"))).toBe(true);
  expect(needsHighPriority(base, with_("dev-work-x", "done"))).toBe(false);
  expect(needsHighPriority(base, with_("dev-wait-new", "working"))).toBe(true);
  expect(needsHighPriority(base, with_("dev-work-x", "stalled"))).toBe(true);
  expect(needsHighPriority(base, with_("dev-failed", "stalled"))).toBe(false); // both "stalled"
  expect(needsHighPriority(base, deriveActivityV2(V2_INPUT, V2_NOW + 45_000))).toBe(false); // heartbeat
  expect(needsHighPriority(null, base)).toBe(true);
  expect(needsHighPriority(null, deriveActivityV2(V2_INPUT.filter(x => x.status === "working"), V2_NOW))).toBe(false);
});

test("v2 pipeline: done session running 2 h still counts; new wait is pushed with priority 10, working→done with 5", async () => {
  const f = fixture(); f.register("start"); f.register("update");
  f.hub.handle(f.row, "user_prompt_submit", MAIN); f.hub.handle(f.row, "stop", MAIN);
  f.advance(20_000); f.hub.sweep();
  expect(f.service.state().sessions[0].status).toBe("done");
  f.advance(2 * 60 * 60_000);
  expect(f.service.state()).toMatchObject({ counts: { done: 1 }, sessions: [{ id: f.row.id, status: "done" }] });
  f.hub.handle(f.row, "user_prompt_submit", MAIN); await f.service.tick();
  expect(f.sent.at(-1)?.push).toMatchObject({ event: "update", priority: 5 });
  f.advance(2_000); f.hub.handle(f.row, "permission_request", { ...MAIN, toolName: "Bash" }); await f.service.tick();
  expect(f.sent.at(-1)?.push).toMatchObject({ event: "update", priority: 10 });
  expect(f.service.state().sessions[0]).toMatchObject({ status: "waiting", reason: "Allow: Bash" });
  f.advance(2_000); f.hub.handle(f.row, "tool_complete", { ...MAIN, toolName: "Bash" }); await f.service.tick();
  expect(f.sent.at(-1)?.push).toMatchObject({ event: "update", priority: 10 }); // the wait disappeared
  f.advance(2_000); f.hub.handle(f.row, "stop", MAIN); f.advance(20_000); f.hub.sweep(); await f.service.tick();
  expect(f.sent.at(-1)?.push).toMatchObject({ event: "update", priority: 5 });
  // An ended session is not shown at all (no 90 s linger).
  f.db.query("UPDATE sessions SET status='stopped' WHERE id=?").run(f.row.id);
  expect(f.service.state().sessions).toHaveLength(0);
});

test("v2 end: live = waiting + working + stalled; done/unknown alone end the activity after 90 s", async () => {
  const f = fixture(); f.register("start"); f.register("update");
  f.hub.handle(f.row, "user_prompt_submit", MAIN); f.advance(4 * 60_000); // silence → stalled
  expect(f.service.state().counts.stalled).toBe(1);
  await f.service.tick(); f.advance(90_000); await f.service.tick();
  expect(f.sent.map(s => s.push.event)).not.toContain("end"); // a stalled session holds the activity
  f.hub.handle(f.row, "stop", MAIN); f.advance(20_000); f.hub.sweep();
  await f.service.tick(); f.advance(89_000); await f.service.tick();
  expect(f.sent.map(s => s.push.event)).not.toContain("end");
  f.advance(1_000); await f.service.tick();
  expect(f.sent.at(-1)?.push).toMatchObject({ event: "end", priority: 10 });
});

test("SSH approval expiry is pushed by the 5 s reconcile tick without request()", async () => {
  const f = fixture(); f.register("start"); f.register("update");
  f.hub.handle(f.row, "user_prompt_submit", MAIN); await f.service.tick();
  f.hub.setSshWaiting(f.row.id, "infra-root"); f.advance(5_000); await f.service.tick();
  expect(f.sent.at(-1)?.push).toMatchObject({ event: "update", priority: 10 });
  f.hub.setSshWaiting(f.row.id, null); f.advance(5_000); await f.service.tick();
  expect(f.sent.at(-1)?.push).toMatchObject({ event: "update", priority: 10 });
  expect(f.service.state().sessions[0].status).toBe("working");
});

test("stalled holds the activity only until STUCK_MS: 5 min still live, 21 min ends after the 90 s grace", async () => {
  const f = fixture(); f.register("start"); f.register("update");
  f.hub.handle(f.row, "user_prompt_submit", MAIN); f.hub.handle(f.row, "stop_failure", MAIN);
  expect(f.service.state().sessions[0]).toMatchObject({ status: "stalled", reason: "Failed with an error" });
  f.advance(5 * 60_000); await f.service.tick(); f.advance(90_000); await f.service.tick();
  expect(f.sent.map(s => s.push.event)).not.toContain("end");
  f.advance(21 * 60_000 - 5 * 60_000 - 90_000); await f.service.tick(); // stalled for 21 min → grace starts
  expect(f.service.state().counts.stalled).toBe(1); // still shown and counted
  expect(f.sent.map(s => s.push.event)).not.toContain("end");
  f.advance(90_000); await f.service.tick();
  expect(f.sent.at(-1)?.push.event).toBe("end");
});

test("computed stall carries the reason \"May be stuck\"", () => {
  const f = fixture(); f.hub.handle(f.row, "user_prompt_submit", MAIN); f.advance(4 * 60_000);
  expect(f.service.state().sessions[0]).toMatchObject({ status: "stalled", reason: "May be stuck" });
});

test("stop and interrupted clear leaked open calls, so the 3 min stall threshold applies again", () => {
  for (const end of ["stop", "interrupted"] as const) {
    const f = fixture(); f.hub.handle(f.row, "user_prompt_submit", MAIN);
    f.hub.handle(f.row, "tool_start", { ...MAIN, toolName: "Bash", toolCallId: "leaked" });
    f.hub.handle(f.row, end, MAIN);
    // The agent continues without a new prompt (interrupted → unknown; new work returns it to "working").
    f.hub.handle(f.row, "subagent_start", CHILD); f.hub.handle(f.row, "subagent_stop", CHILD);
    expect(top(f)).toBe("working");
    f.advance(4 * 60_000);
    expect(top(f)).toBe("stalled");
  }
});

test("changedAt never goes backwards when the most recently changed session exits", () => {
  const f = fixture();
  const other: SessionRow = { ...f.row, id: "dev-shop-web", repo: "web", port_base: 1100 };
  insertSession(f.db, other);
  f.hub.handle(f.row, "user_prompt_submit", MAIN); f.advance(60_000);
  f.hub.handle(other, "user_prompt_submit", MAIN);
  const before = f.service.state().changedAt;
  expect(before).toBe(new Date(f.now()).toISOString());
  f.db.query("UPDATE sessions SET status='stopped' WHERE id=?").run(other.id);
  f.advance(5_000);
  expect(f.service.state().changedAt).toBe(before);
});

test("a stalled session over several 5 s ticks sends no push until the heartbeat", async () => {
  const f = fixture(); f.register("start"); f.register("update");
  f.hub.handle(f.row, "user_prompt_submit", MAIN); f.advance(4 * 60_000);
  expect(top(f)).toBe("stalled");
  await f.service.tick(); const sent = f.sent.length;
  for (let i = 0; i < 8; i++) { f.advance(5_000); await f.service.tick(); } // 40 s
  expect(f.sent).toHaveLength(sent);
  f.advance(5_000); await f.service.tick(); // 45 s = HEARTBEAT_MS
  expect(f.sent).toHaveLength(sent + 1);
  expect(f.sent.at(-1)?.push).toMatchObject({ event: "update", priority: 5 });
});
