// Adds cost.usage to historical token.usage rows of models that had no price list
// at write time (devd then stored only tokens). The default run is a read-only
// preview; --apply writes. Idempotent: a token row that already has a
// cost row with the same (source_id, ts, type) is skipped — so it can be run
// again even after a devd restart, when the harvester already writes the price itself.
// Long-context rate: the event prompt = input + cacheRead + cacheWrite of rows with
// the same (source_id, ts); rows without source_id (OTLP) get the standard rate.
// Revert: DELETE FROM metrics WHERE name='claude_code.cost.usage'
//   AND json_extract(attrs,'$."devbox.cost.backfill"')=<BACKFILL>.
import { Database } from "bun:sqlite";
import { insertMetrics, type MetricRow } from "../devd/src/db";
import { costOf, hasPrice, PRICE_CHECKED_AT, type TokenKind } from "../devd/src/pricing";

const BACKFILL = "unpriced-models-2026-10-14";
const TOKEN = "claude_code.token.usage", COST = "claude_code.cost.usage";
const KINDS: Record<string, TokenKind> = { input: "input", cacheRead: "cacheRead", cacheCreation: "cacheWrite", output: "output" };

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const [dbPath, ...models] = args.filter((a) => a !== "--apply");
if (!dbPath || models.length === 0) throw new Error("Usage: bun tools/backfill-unpriced-cost.ts DATABASE MODEL... [--apply]");
for (const m of models) if (!hasPrice(m)) throw new Error(`model ${m} is not in the price list`);

const db = new Database(dbPath, apply ? { readwrite: true, create: false } : { readonly: true });
db.exec("PRAGMA busy_timeout=10000");
const ph = models.map(() => "?").join(",");
const key = (src: unknown, ts: number, type: unknown) => `${src ?? ""}|${ts}|${type}`;

const existing = new Set<string>();
for (const r of db.query(`SELECT ts, attrs FROM metrics WHERE name=? AND a_model IN (${ph})`).all(COST, ...models) as { ts: number; attrs: string }[]) {
  const a = JSON.parse(r.attrs); existing.add(key(a["devbox.usage.source_id"], r.ts, a.type));
}
const rows = db.query(`SELECT id, ts, session_id, value, attrs FROM metrics WHERE name=? AND a_model IN (${ph}) ORDER BY id`)
  .all(TOKEN, ...models) as { id: number; ts: number; session_id: string | null; value: number; attrs: string }[];
const parsed = rows.map((r) => ({ ...r, a: JSON.parse(r.attrs) as Record<string, unknown> }));
const prompt = new Map<string, number>();
for (const r of parsed) {
  const src = r.a["devbox.usage.source_id"];
  if (!src || KINDS[String(r.a.type)] === "output") continue;
  const k = `${src}|${r.ts}`; prompt.set(k, (prompt.get(k) ?? 0) + r.value);
}

const out: MetricRow[] = [];
let skipped = 0, longCtx = 0;
const byModel: Record<string, number> = {};
for (const r of parsed) {
  const kind = KINDS[String(r.a.type)], model = String(r.a.model), src = r.a["devbox.usage.source_id"];
  if (!kind || !(r.value > 0)) continue;
  if (existing.has(key(src, r.ts, r.a.type))) { skipped++; continue; }
  const p = src ? prompt.get(`${src}|${r.ts}`) : undefined;
  if (p !== undefined && p > 272_000) longCtx++;
  const cost = costOf(model, kind, r.value, p, r.ts)!;
  if (cost <= 0) continue;
  byModel[model] = (byModel[model] ?? 0) + cost;
  out.push({ ts: r.ts, session_id: r.session_id, name: COST, value: cost, attrs: JSON.stringify({
    ...r.a, "devbox.cost.basis": "standard-api-estimate", "devbox.cost.price_date": PRICE_CHECKED_AT,
    "devbox.cost.backfill": BACKFILL, "devbox.cost.token_row_id": String(r.id) }) });
}
console.log(JSON.stringify({ apply, tokenRows: rows.length, alreadyPriced: skipped, costRows: out.length, longContextRows: longCtx,
  usdByModel: Object.fromEntries(Object.entries(byModel).map(([m, v]) => [m, Math.round(v * 100) / 100])) }, null, 2));
// Small batches with a pause: devd writes to the same DB and a long write lock knocks it
// into SQLITE_BUSY (happened 2026-10-14 with batches of 20k).
if (apply) for (let i = 0; i < out.length; i += 1_000) { insertMetrics(db, out.slice(i, i + 1_000)); await Bun.sleep(50); }
db.close();
