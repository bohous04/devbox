import { expect, test } from "bun:test";
import { openDb, insertMetrics } from "../src/db";
import { repairCodexStats, validateCodexRepairSources, type CodexRepairManifest } from "../src/codexStatsRepair";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function fixture(dbPath = ":memory:") {
  const db = openDb(dbPath);
  for (const [type,value] of [["input",1000],["cacheRead",500],["output",100]] as const) {
    insertMetrics(db,[{ ts:1000,session_id:null,name:"claude_code.token.usage",value,attrs:JSON.stringify({"devbox.host":"devbox",type}) }]);
  }
  const rows = db.query("SELECT id,ts,session_id,name,value,attrs FROM metrics ORDER BY id").all() as any[];
  const delta = {input:1000,cacheRead:500,cacheWrite:0,output:100};
  const manifest: CodexRepairManifest = {version:1,metricsHighwaterId:3,blocks:[{
    originalRows:rows,rolloutId:"01a02b62-df37-7982-8670-c2f2460b3c26",model:"gpt-6-astra",
    uniqueCandidateCount:1,labelEligible:true,costEligible:true,costSkipReasons:[],delta,
    usage:[{totals:delta,promptTokens:1500}],
  }]};
  return {db,manifest};
}

test("repair defaults read-only; apply changes labels/costs, never token values; replay is idempotent", () => {
  const {db,manifest}=fixture();
  const dry=repairCodexStats(db,manifest);
  expect(dry.pending).toBe(3);
  expect(dry.estimatedUsd).toBeCloseTo(0.0155);
  expect(db.query("SELECT count(*) n FROM metrics").get()).toEqual({n:3});
  expect(db.query("SELECT name FROM sqlite_master WHERE name='codex_stats_repairs'").get()).toBeNull();
  repairCodexStats(db,manifest,true);
  expect(db.query("SELECT sum(value) n FROM metrics WHERE name='claude_code.token.usage'").get()).toEqual({n:1600});
  expect(db.query("SELECT DISTINCT a_model model FROM metrics").all()).toEqual([{model:"gpt-6-astra"}]);
  expect(db.query("SELECT count(*) n FROM metrics").get()).toEqual({n:6});
  const replay=repairCodexStats(db,manifest,true);
  expect(replay.pending).toBe(0); expect(replay.alreadyApplied).toBe(3);
  expect(db.query("SELECT count(*) n FROM metrics").get()).toEqual({n:6});
});

test("stale row aborts the whole batch before any label/cost is changed", () => {
  const {db,manifest}=fixture();
  db.run("UPDATE metrics SET value=value+1 WHERE id=3");
  expect(()=>repairCodexStats(db,manifest,true)).toThrow("stale original token row 3");
  expect(db.query("SELECT count(*) n FROM metrics WHERE a_model IS NOT NULL").get()).toEqual({n:0});
  expect(db.query("SELECT count(*) n FROM metrics").get()).toEqual({n:3});
});

test("ambiguous or inconsistent pricing proof is refused", () => {
  const {db,manifest}=fixture();
  manifest.blocks[0].uniqueCandidateCount=2;
  expect(()=>repairCodexStats(db,manifest,true)).toThrow("ambiguous");
  manifest.blocks[0].uniqueCandidateCount=1;
  manifest.blocks[0].usage=[{totals:{input:1,cacheRead:0,cacheWrite:0,output:0},promptTokens:1}];
  expect(()=>repairCodexStats(db,manifest,true)).toThrow("request deltas");
  expect(db.query("SELECT count(*) n FROM metrics").get()).toEqual({n:3});
});

test("reset block can receive a proven model without inventing a price", () => {
  const {db,manifest}=fixture();
  manifest.blocks[0].costEligible=false;
  manifest.blocks[0].costSkipReasons=["counter reset"];
  manifest.blocks[0].usage=[];
  const applied=repairCodexStats(db,manifest,true);
  expect(applied.costSkippedRows).toBe(3); expect(applied.costRows).toBe(0);
  expect(db.query("SELECT count(*) n FROM metrics").get()).toEqual({n:3});
  expect(repairCodexStats(db,manifest,true).alreadyApplied).toBe(3);
});

test("insert failure rolls back both labels and repair ledger", () => {
  const {db,manifest}=fixture();
  db.run("CREATE TRIGGER fail_cost BEFORE INSERT ON metrics WHEN NEW.name='claude_code.cost.usage' BEGIN SELECT RAISE(ABORT, 'test cost failure'); END");
  expect(()=>repairCodexStats(db,manifest,true)).toThrow("test cost failure");
  expect(db.query("SELECT count(*) n FROM metrics WHERE a_model IS NOT NULL").get()).toEqual({n:0});
  expect(db.query("SELECT name FROM sqlite_master WHERE name='codex_stats_repairs'").get()).toBeNull();
});

test("source verification permits append-only growth but rejects changed and truncated evidence", () => {
  const {manifest}=fixture();
  const root=mkdtempSync(join(tmpdir(),"codex-repair-source-"));
  const id=manifest.blocks[0].rolloutId, path=`rollout-2026-09-10T00-00-00-${id}.jsonl`;
  const content="synthetic metadata\n";
  manifest.sources={[id]:{path,sourcePrefixBytes:Buffer.byteLength(content),sourcePrefixSha256:createHash("sha256").update(content).digest("hex"),models:["gpt-6-astra"]}};
  try {
    writeFileSync(join(root,path),content);
    expect(()=>validateCodexRepairSources(manifest,root)).not.toThrow();
    appendFileSync(join(root,path),"new metadata\n");
    expect(()=>validateCodexRepairSources(manifest,root)).not.toThrow();
    writeFileSync(join(root,path),"X"+content.slice(1));
    expect(()=>validateCodexRepairSources(manifest,root)).toThrow("changed source prefix");
    writeFileSync(join(root,path),"");
    expect(()=>validateCodexRepairSources(manifest,root)).toThrow("truncated source prefix");
  } finally { rmSync(root,{recursive:true,force:true}); }
});

test("CLI apply opens an existing disk database for writing after source validation", () => {
  const root=mkdtempSync(join(tmpdir(),"codex-repair-cli-"));
  const dbPath=join(root,"metrics.sqlite"), manifestPath=join(root,"manifest.json");
  const {db,manifest}=fixture(dbPath);
  try {
    const id=manifest.blocks[0].rolloutId, path=`rollout-2026-09-10T00-00-00-${id}.jsonl`, content="fixture\n";
    writeFileSync(join(root,path),content);
    manifest.sources={[id]:{path,sourcePrefixBytes:Buffer.byteLength(content),sourcePrefixSha256:createHash("sha256").update(content).digest("hex"),models:["gpt-6-astra"]}};
    writeFileSync(manifestPath,JSON.stringify(manifest));
    const result=Bun.spawnSync([process.execPath,join(import.meta.dir,"../../tools/codex-stats-repair.ts"),dbPath,manifestPath,"--apply"],{env:{...process.env,CODEX_REPAIR_SESSIONS:root}});
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString()).costRows).toBe(3);
    expect(db.query("SELECT count(*) n FROM metrics").get()).toEqual({n:6});
  } finally { db.close();rmSync(root,{recursive:true,force:true}); }
});
