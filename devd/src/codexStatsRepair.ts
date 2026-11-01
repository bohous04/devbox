import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { closeSync, openSync, readSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import { insertMetrics, type MetricRow } from "./db";
import { costOf, hasPrice, PRICE_CHECKED_AT, type TokenKind } from "./pricing";
import type { TokenTotals } from "./harvest";

interface OriginalRow extends MetricRow { id: number }
interface RepairBlock {
  originalRows: OriginalRow[];
  rolloutId: string; model: string; uniqueCandidateCount: number;
  labelEligible: boolean; costEligible: boolean; costSkipReasons: string[];
  delta: TokenTotals;
  usage: { totals: TokenTotals; promptTokens?: number }[];
}
export interface CodexRepairManifest {
  version: number; metricsHighwaterId: number; blocks: RepairBlock[];
  sources?: Record<string, { path: string; sourcePrefixBytes: number; sourcePrefixSha256: string; models: string[] }>;
}
const REPAIR = "codex-model-price-2026-09-10-v1";
const TOKEN = "claude_code.token.usage";
const COST = "claude_code.cost.usage";
const KINDS: Record<string, TokenKind> = { input: "input", cacheRead: "cacheRead", cacheCreation: "cacheWrite", output: "output" };
const fingerprint = (r: OriginalRow) => createHash("sha256").update(JSON.stringify([r.id,r.ts,r.session_id,r.name,r.value,r.attrs])).digest("hex");
const zero = (): TokenTotals => ({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });
function requireProof(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(`Codex repair refused: ${message}`); }
const sameTotals = (a: TokenTotals, b: TokenTotals) => Object.keys(a).every(k => a[k as TokenKind] === b[k as TokenKind]);

/** Mandatory CLI preflight against the actual rollout evidence. Later appends are
 * allowed; a changed/truncated prefix invalidates the historical attribution. */
export function validateCodexRepairSources(manifest: CodexRepairManifest, sessionsRoot: string): void {
  const root = realpathSync(sessionsRoot);
  const used = new Map(manifest.blocks.map(b => [b.rolloutId,b.model]));
  const buffer = Buffer.alloc(1_048_576);
  for (const [id,model] of used) {
    const source = manifest.sources?.[id];
    requireProof(source && source.models.length === 1 && source.models[0] === model, `missing or changed source model ${id}`);
    requireProof(Number.isSafeInteger(source.sourcePrefixBytes) && source.sourcePrefixBytes > 0 && /^[a-f0-9]{64}$/.test(source.sourcePrefixSha256), `invalid source fingerprint ${id}`);
    const path = realpathSync(resolve(root,source.path));
    requireProof(path.startsWith(root + sep) && path.endsWith(`-${id}.jsonl`), `source outside rollout directory ${id}`);
    const fd = openSync(path,"r");
    try {
      const hash = createHash("sha256");
      let remaining = source.sourcePrefixBytes;
      while (remaining > 0) {
        const count = readSync(fd,buffer,0,Math.min(buffer.length,remaining),null);
        requireProof(count > 0, `truncated source prefix ${id}`);
        hash.update(buffer.subarray(0,count)); remaining -= count;
      }
      requireProof(hash.digest("hex") === source.sourcePrefixSha256, `changed source prefix ${id}`);
    } finally { closeSync(fd); }
  }
}

/** In-place repair only. A ledger keyed by original token row prevents cost duplication.
 * Default is read-only; --apply belongs to a separate explicitly authorized step. */
export function repairCodexStats(db: Database, manifest: CodexRepairManifest, apply = false) {
  requireProof(manifest.version === 1 && Array.isArray(manifest.blocks), "unsupported manifest");
  const seen = new Set<number>();
  const plans: { row: OriginalRow; attrs: string; cost: number | null; model: string; rolloutId: string }[] = [];
  for (const block of manifest.blocks) {
    requireProof(block.labelEligible && block.uniqueCandidateCount === 1, "ambiguous model attribution");
    requireProof(/^[0-9a-f-]{36}$/.test(block.rolloutId) && hasPrice(block.model), "invalid rollout/model");
    const tokenTotals = zero();
    for (const row of block.originalRows) {
      const old = JSON.parse(row.attrs);
      const kind = KINDS[old.type];
      requireProof(Number.isSafeInteger(row.id) && row.id > 0 && row.id <= manifest.metricsHighwaterId && !seen.has(row.id), "duplicate or invalid token row");
      requireProof(row.name === TOKEN && Number.isFinite(row.value) && row.value > 0 && kind, "invalid token metric");
      requireProof(!old.model && old["devbox.host"] === "devbox" && !old["devbox.agent"] && !old["devbox.usage.source_id"], "not a legacy unknown devbox row");
      seen.add(row.id); tokenTotals[kind] += row.value;
    }
    requireProof(sameTotals(tokenTotals, block.delta), "original rows do not equal proven delta");
    const costs = zero();
    if (block.costEligible) {
      // Legacy input buckets included writes. Pricing both would double-charge;
      // preserve token values and leave those historical blocks label-only.
      requireProof(tokenTotals.cacheWrite === 0, "legacy cache-write tokens cannot be safely repriced");
      const usageTotals = zero();
      requireProof(block.costSkipReasons.length === 0 && block.usage.length > 0, "missing request pricing proof");
      for (const usage of block.usage) {
        requireProof(Number.isFinite(usage.promptTokens) && usage.promptTokens! >= 0, "missing request input count");
        for (const kind of Object.keys(costs) as TokenKind[]) {
          const tokens = usage.totals[kind];
          requireProof(Number.isFinite(tokens) && tokens >= 0, "invalid request token count");
          usageTotals[kind] += tokens;
          costs[kind] += costOf(block.model, kind, tokens, usage.promptTokens)!;
        }
      }
      requireProof(sameTotals(usageTotals, tokenTotals), "request deltas do not equal original tokens");
    }
    for (const row of block.originalRows) {
      const old = JSON.parse(row.attrs), kind = KINDS[old.type];
      const attrs = JSON.stringify({ ...old, model: block.model, "devbox.agent": "codex", "devbox.usage.source_id": block.rolloutId, "devbox.usage.repair": REPAIR });
      plans.push({ row, attrs, model: block.model, rolloutId: block.rolloutId,
        cost: block.costEligible ? costs[kind] * row.value / tokenTotals[kind] : null });
    }
  }

  const run = () => {
    const ledgerExists = !!db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='codex_stats_repairs'").get();
    const pending: typeof plans = [];
    let alreadyApplied = 0;
    // Validate every original first. A stale manifest rolls back the entire repair.
    for (const plan of plans) {
      const current = db.query("SELECT id,ts,session_id,name,value,attrs FROM metrics WHERE id=?").get(plan.row.id) as OriginalRow | null;
      requireProof(current, `missing token row ${plan.row.id}`);
      const ledger = ledgerExists ? db.query("SELECT original_hash,corrected_attrs,cost_id,cost_value FROM codex_stats_repairs WHERE token_id=?").get(plan.row.id) as { original_hash: string; corrected_attrs: string; cost_id: number | null; cost_value: number | null } | null : null;
      if (ledger) {
        requireProof(ledger.original_hash === fingerprint(plan.row) && ledger.corrected_attrs === plan.attrs && ledger.cost_value === plan.cost, `different repair already recorded for ${plan.row.id}`);
        requireProof(fingerprint({ ...current, attrs: plan.row.attrs }) === fingerprint(plan.row) && current.attrs === plan.attrs, `repaired token row changed ${plan.row.id}`);
        if (ledger.cost_id !== null) {
          const cost = db.query("SELECT name,value,attrs FROM metrics WHERE id=?").get(ledger.cost_id) as { name: string; value: number; attrs: string } | null;
          requireProof(cost?.name === COST && cost.value === plan.cost && JSON.parse(cost.attrs)["devbox.cost.token_row_id"] === String(plan.row.id), `repaired cost changed ${plan.row.id}`);
        }
        alreadyApplied++; continue;
      }
      requireProof(fingerprint(current) === fingerprint(plan.row), `stale original token row ${plan.row.id}`);
      pending.push(plan);
    }
    const result = { apply, tokenRows: plans.length, pending: pending.length, alreadyApplied,
      costRows: pending.filter(p => p.cost !== null && p.cost > 0).length,
      costSkippedRows: pending.filter(p => p.cost === null).length,
      estimatedUsd: pending.reduce((n,p) => n + (p.cost ?? 0), 0), tokenValuesChanged: 0 };
    if (!apply || pending.length === 0) return result;
    db.run(`CREATE TABLE IF NOT EXISTS codex_stats_repairs (
      token_id INTEGER PRIMARY KEY, original_hash TEXT NOT NULL, original_attrs TEXT NOT NULL,
      corrected_attrs TEXT NOT NULL, cost_id INTEGER, cost_value REAL, repaired_at INTEGER NOT NULL)`);
    for (const plan of pending) {
      db.query("UPDATE metrics SET attrs=?,a_model=? WHERE id=?").run(plan.attrs,plan.model,plan.row.id);
      let costId: number | null = null;
      if (plan.cost !== null && plan.cost > 0) {
        insertMetrics(db, [{ ts: plan.row.ts, session_id: plan.row.session_id, name: COST, value: plan.cost,
          attrs: JSON.stringify({ ...JSON.parse(plan.attrs), "devbox.cost.basis": "standard-api-estimate", "devbox.cost.price_date": PRICE_CHECKED_AT, "devbox.cost.token_row_id": String(plan.row.id) }) }]);
        costId = (db.query("SELECT last_insert_rowid() id").get() as { id: number }).id;
      }
      db.query("INSERT INTO codex_stats_repairs VALUES (?,?,?,?,?,?,?)").run(plan.row.id,fingerprint(plan.row),plan.row.attrs,plan.attrs,costId,plan.cost,Date.now());
    }
    return result;
  };
  // IMMEDIATE reserves the writer before checking originals (no read/write race).
  return apply ? db.transaction(run).immediate() : run();
}
