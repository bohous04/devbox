import { test, expect } from "bun:test";
import { insertSession, openDb } from "../src/db";
import { isRuntimeProcess, launchAgentStatus, parseAgentVersion, updateLaunchAgent } from "../src/agentUpkeep";
import type { ExecResult, UpkeepDeps } from "../src/ccUpkeep";
const ok = (stdout = ""):ExecResult => ({code:0,stdout,stderr:"",timedOut:false});
function setup() {
  const db=openDb(":memory:");
  insertSession(db,{id:"a",folder:"f",project:"p",repo:"r",container:"dev-a",port_base:40100,status:"running",solo:0,created_at:0,last_active_at:0,important:0});
  const calls:string[][]=[];
  let installed="1.0.0";
  const d:UpkeepDeps={db,repoDir:"/repo",image:"devbox:latest",sleep:async()=>{},notify:()=>{},turnInProgress:()=>false,
    host:async(cmd)=>{calls.push(cmd);return ok(cmd.includes("--version") ? "grok 1.0.0" : "1.0.1");},
    exec:async(_container,cmd)=>{calls.push(cmd);if(cmd[0]==="/usr/local/bin/agent-auto-update"){installed="1.0.1";return ok();}if(cmd.includes("--version"))return ok(`grok ${installed}`);if(cmd[0]==="ps")return ok("1 0 900 bash\n2 1 300 grok-native\n3 1 300 claude");return ok("100");},
  };
  return {d,calls};
}
test("provider versions and native Grok names are recognized without treating CC as GR",()=>{
  expect(parseAgentVersion("codex-cli 0.148.0")).toBe("0.148.0");
  expect(parseAgentVersion("grok 1.0.8")).toBe("1.0.8");
  expect(parseAgentVersion("oops 1.0.8")).toBeNull();
  for(const name of ["grok","grok-native","grok-pager","grok-1.0.8","xai-grok-pager"]) expect(isRuntimeProcess(name,"grok")).toBe(true);
  expect(isRuntimeProcess("claude","grok")).toBe(false);
});
test("status uses native stable release source and reports old running process",async()=>{
  const {d,calls}=setup();
  const s=await launchAgentStatus(d,"grok");
  expect(s.latest).toBe("1.0.1");expect(s.mode).toBe("on-launch");
  expect(s.sessions[0]?.running).toBe(1);expect(s.sessions[0]?.restartRequired).toBe(true);
  expect(calls.some(c=>c.includes("https://x.ai/cli/stable"))).toBe(true);
  expect(calls.some(c=>c[0]==="/usr/local/bin/agent-auto-update")).toBe(false);
});
test("manual update reuses existing atomic helper without image, auth or tmux changes",async()=>{
  const {d,calls}=setup();
  expect((await updateLaunchAgent(d,"grok")).updated).toEqual(["a"]);
  expect(calls.some(c=>c.join(" ")==="/usr/local/bin/agent-auto-update grok")).toBe(true);
  expect(calls.some(c=>c.includes("send-keys")||c.includes("build")||c.includes("auth.json")||c.includes("sudo"))).toBe(false);
});
test("active work is deferred and cooldown no-op is not claimed as an update",async()=>{
  const {d,calls}=setup();d.turnInProgress=()=>true;
  expect((await updateLaunchAgent(d,"grok")).deferred).toEqual(["a"]);
  expect(calls.some(c=>c[0]==="/usr/local/bin/agent-auto-update")).toBe(false);
  d.turnInProgress=()=>false;d.exec=async(_c,cmd)=>ok(cmd.includes("--version")?"grok 1.0.0":"");
  const result=await updateLaunchAgent(d,"grok");expect(result.updated).toEqual([]);expect(result.deferred).toEqual(["a"]);
});
test("failed probes remain unknown and failed install is surfaced",async()=>{
  const {d}=setup();d.exec=async()=>({code:1,stdout:"",stderr:"secret",timedOut:false});
  const s=await launchAgentStatus(d,"grok");expect(s.sessions[0]?.version).toBeNull();expect(s.sessions[0]?.running).toBeNull();
  const result=await updateLaunchAgent(d,"grok");expect(result.failed).toEqual(["a"]);expect(JSON.stringify(result)).not.toContain("secret");
});
test("agy: version from bare output and the agy process", () => {
  expect(parseAgentVersion("1.3.5\n")).toBe("1.3.5");
  expect(isRuntimeProcess("agy", "agy")).toBe(true);
  expect(isRuntimeProcess("grok", "agy")).toBe(false);
  expect(isRuntimeProcess("agy", "grok")).toBe(false);
});
test("updateLaunchAgent(agy) changes nothing and explains why", async () => {
  const calls: string[][] = [];
  const db = openDb(":memory:");
  const d: UpkeepDeps = {
    db, repoDir: "/repo", image: "devbox:latest", sleep: async () => {}, notify: () => {}, turnInProgress: () => false,
    host: async (cmd) => { calls.push(cmd); return ok("1.3.5"); },
    exec: async (_container, cmd) => { calls.push(cmd); return ok("1.3.5"); },
  };
  const r = await updateLaunchAgent(d, "agy");
  expect(r.error).toContain("image");
  expect(r.updated).toEqual([]);
  expect(calls.some((c) => c.includes("agent-auto-update"))).toBe(false);
});
