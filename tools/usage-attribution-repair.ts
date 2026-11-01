// Repair of historical Codex/Grok usage without a repo ("Unknown" in Stats). Run on the VPS:
//   bun tools/usage-attribution-repair.ts [DATABASE] [--apply | --undo]   (default: plan only)
// Evidence is read read-only from volumes: session_meta of Codex rollouts and Grok's summary.json.
import { Database } from "bun:sqlite";
import { closeSync, openSync, readSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { applyUsageAttribution, planUsageAttribution, undoUsageAttribution, type AttributionEvidence } from "../devd/src/usageAttributionRepair";

const args = process.argv.slice(2);
const mode = args.find((a) => a.startsWith("--"));
const dbPath = args.find((a) => !a.startsWith("--")) ?? "/var/lib/devd/devd.sqlite";
if (mode && mode !== "--apply" && mode !== "--undo") throw new Error("Usage: bun tools/usage-attribution-repair.ts [DATABASE] [--apply | --undo]");
const VOLUMES = process.env.DOCKER_VOLUMES ?? "/var/lib/docker/volumes";
const ROLLOUT_RE = /^rollout-[\d T:-]*-([0-9a-f-]{36})\.jsonl$/;
const UUID_RE = /^[0-9a-f-]{36}$/;
const SESSION_ROOT_RE = /^\/srv\/dev\/_sessions\/(dev-[A-Za-z0-9._-]+)\/?$/;

function firstLine(path: string): string {
  const fd = openSync(path, "r");
  try {
    const chunks: Buffer[] = [];
    const buf = Buffer.alloc(1 << 20);
    for (let total = 0; total < 64 << 20;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      const nl = buf.subarray(0, n).indexOf(10);
      chunks.push(Buffer.from(buf.subarray(0, nl === -1 ? n : nl)));
      if (nl !== -1) break;
      total += n;
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally { closeSync(fd); }
}

function* walk(dir: string): Generator<string> {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile()) yield p;
  }
}

function collectEvidence(): AttributionEvidence {
  const codexRoots = readdirSync(VOLUMES).filter((v) => v.startsWith("codex-")).map((v) => join(VOLUMES, v, "_data"));
  codexRoots.push("/var/lib/codex-remote-home");
  const codexParents: Record<string, string> = {};
  for (const root of codexRoots) for (const folder of ["sessions", "archived_sessions"]) {
    for (const path of walk(join(root, folder))) {
      const id = path.split("/").at(-1)!.match(ROLLOUT_RE)?.[1];
      if (!id || codexParents[id]) continue;
      try {
        const meta = JSON.parse(firstLine(path));
        const parent = meta?.type === "session_meta" ? meta.payload?.source?.subagent?.thread_spawn?.parent_thread_id : undefined;
        if (typeof parent === "string" && UUID_RE.test(parent)) codexParents[id] = parent;
      } catch { /* unreadable rollout = no evidence */ }
    }
  }
  const grokSessions: Record<string, string> = {};
  const grokRoot = join(VOLUMES, "grok-home", "_data", "sessions");
  if (existsSync(grokRoot)) for (const cwd of readdirSync(grokRoot)) {
    const dir = join(grokRoot, cwd);
    let sids: string[] = [];
    try { sids = readdirSync(dir); } catch { continue; }
    for (const sid of sids) {
      try {
        const summary = JSON.parse(readFileSync(join(dir, sid, "summary.json"), "utf8"));
        const session = typeof summary.git_root_dir === "string" ? summary.git_root_dir.match(SESSION_ROOT_RE)?.[1] : undefined;
        if (session && UUID_RE.test(sid)) grokSessions[sid] = session;
      } catch { /* no summary.json */ }
    }
  }
  return { codexParents, grokSessions };
}

const db = new Database(dbPath, mode ? { readwrite: true, create: false } : { readonly: true });
db.exec("PRAGMA busy_timeout=10000");
try {
  if (mode === "--undo") {
    console.log(JSON.stringify({ restoredRows: undoUsageAttribution(db) }));
  } else {
    const ev = collectEvidence();
    const plan = planUsageAttribution(db, ev);
    const tokens = (ids: number[]) => ids.length === 0 ? 0 : (db.query(
      `SELECT COALESCE(SUM(value), 0) s FROM metrics WHERE name = 'claude_code.token.usage' AND id IN (${ids.join(",")})`).get() as { s: number }).s;
    const byRepo: Record<string, { sources: number; rows: number; tokens: number }> = {};
    for (const e of plan.entries) {
      const k = `${e.agent} ${e.target.project}/${e.target.repo} (${e.via.split(":")[0]})`;
      const a = byRepo[k] ??= { sources: 0, rows: 0, tokens: 0 };
      a.sources++; a.rows += e.rowIds.length;
      for (let i = 0; i < e.rowIds.length; i += 50_000) a.tokens += tokens(e.rowIds.slice(i, i + 50_000));
    }
    const unresolved: Record<string, { sources: number; rows: number }> = {};
    for (const u of plan.unresolved) {
      const a = unresolved[`${u.agent} ${u.reason}`] ??= { sources: 0, rows: 0 };
      a.sources++; a.rows += u.rows;
    }
    console.log(JSON.stringify({ evidence: { codexSubagents: Object.keys(ev.codexParents).length, grokSessions: Object.keys(ev.grokSessions).length },
      resolved: Object.fromEntries(Object.entries(byRepo).sort((a, b) => b[1].tokens - a[1].tokens)), unresolved }, null, 2));
    if (mode === "--apply") console.log(JSON.stringify(applyUsageAttribution(db, plan)));
  }
} finally { db.close(); }
