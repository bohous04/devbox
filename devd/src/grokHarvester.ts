// Grok Build (the gr binary) sends no telemetry. The only source of usage is
// the shared grok-home volume: logs/unified.jsonl, to which EVERY grok process (from all
// containers) appends a shell.turn.inference_done line for each turn — sid,
// prompt/cached/completion tokens. The harvester reads increments from an offset and moves
// them into the metrics table (tokens + cost from the price list).
//
// Attribution sid → devbox session: primarily the map from the session-start hook
// (harvest_state "grok-sids", filled by api.ts), fallback time correlation via
// notify_log (the only grok session with an open turn). An unassigned turn waits
// in pending and after PENDING_MAX_MS is stored without a session — at least for the per-model totals.
// Headless grok (started by another agent) sends no hooks; its summary.json, however, carries
// git_root_dir = /srv/dev/_sessions/<devbox session id>/, and that takes precedence over correlation.
import type { Database } from "bun:sqlite";
import { GROK_VOLUME, runInVolume } from "./agentAuth";
import type { CodexPollerDeps } from "./codexPoller";
import { getHarvestState, getSession, insertMetrics, setHarvestState, type MetricRow } from "./db";
import { usageMetricRows, type TokenTotals } from "./harvest";

export interface GrokTurn { sid: string; ts: number; totals: TokenTotals; promptTokens: number }
interface GrokState {
  offset: number; pending: (GrokTurn & { firstSeenAt: number })[]; models: Record<string, string>;
  // sid → devbox session from git_root_dir ("" = sid looked up, but not in a session worktree).
  roots?: Record<string, string>;
}
// project/repo are stored RIGHT AT registration (api.ts has the whole SessionRow at that time) —
// getSession a few cycles later may return null (the session has ended meanwhile and
// deleteSession deleted it), the map is then the only source of attribution (see harvestGrok below).
export type GrokSidMap = Record<string, { session: string; project: string; repo: string; ts: number }>;

const GROK_HOME = "/home/dev/.grok";
const LOG = `${GROK_HOME}/logs/unified.jsonl`;
export const PENDING_MAX_MS = 10 * 60_000;
// Tolerance for hook delays and the harvest cadence when correlating turn ↔ prompt/stop.
const GRACE_MS = 60_000;
const MAX_MODELS_CACHED = 100;
// `sid` is raw data from the shared volume (unified.jsonl is written by ALL grok
// processes from ALL containers) and is further interpolated into the shell script of the second docker
// run (looking up summary.json by sid in the path) — defense-in-depth against injection:
// an untrusted/corrupted sid is discarded right at parsing, not only just before the shell.
const SAFE_SID_RE = /^[0-9a-f-]+$/i;
const SESSION_ROOT_RE = /^\/srv\/dev\/_sessions\/(dev-[A-Za-z0-9._-]+)\/?$/;

export function parseUnifiedChunk(chunk: string): { turns: GrokTurn[]; consumedBytes: number } {
  const turns: GrokTurn[] = [];
  let consumed = 0;
  let rest = chunk;
  while (true) {
    const nl = rest.indexOf("\n");
    if (nl === -1) break; // the last fragment without \n is not consumed — it gets completed and read next time
    const line = rest.slice(0, nl);
    rest = rest.slice(nl + 1);
    consumed += Buffer.byteLength(line) + 1;
    if (line.trim() === "") continue;
    let j: { ts?: string; sid?: string; msg?: string; ctx?: Record<string, unknown> };
    try { j = JSON.parse(line); } catch { continue; } // a foreign/corrupted line is not a harvest error
    if (j.msg !== "shell.turn.inference_done" || typeof j.sid !== "string") continue;
    if (!SAFE_SID_RE.test(j.sid)) continue; // malformed/untrusted sid — see the comment at SAFE_SID_RE
    const ts = Date.parse(j.ts ?? "");
    const n = (k: string) => { const v = j.ctx?.[k]; return typeof v === "number" && Number.isFinite(v) ? v : 0; };
    const prompt = n("prompt_tokens"), cached = n("cached_prompt_tokens");
    // xAI counts reasoning_tokens OUTSIDE completion_tokens (total = prompt + completion
    // + reasoning) and bills them at the output rate — without them the output cost comes out low.
    turns.push({
      sid: j.sid, ts: Number.isFinite(ts) ? ts : Date.now(),
      totals: { input: Math.max(0, prompt - cached), cacheRead: cached, cacheWrite: 0, output: n("completion_tokens") + n("reasoning_tokens") },
      promptTokens: prompt,
    });
  }
  return { turns, consumedBytes: consumed };
}

/** Fallback correlation: candidate = a session with agent='grok' whose last
 *  prompt/stop event before (ts + GRACE_MS) is user_prompt_submit — i.e. it has
 *  an open turn. Assigned ONLY if there is exactly one candidate. */
export function attributeGrokTurn(db: Database, sid: string, tsMs: number, sidMap: GrokSidMap): string | null {
  const mapped = sidMap[sid];
  if (mapped) return mapped.session;
  const grokSessions = db.query(`SELECT id FROM sessions WHERE agent = 'grok'`).all() as { id: string }[];
  const candidates = grokSessions.filter((s) => {
    const last = db.query(`SELECT event FROM notify_log WHERE session_id = ? AND event IN ('user_prompt_submit','stop')
      AND ts <= ? ORDER BY ts DESC, id DESC LIMIT 1`).get(s.id, tsMs + GRACE_MS) as { event: string } | null;
    return last?.event === "user_prompt_submit";
  });
  return candidates.length === 1 ? candidates[0].id : null;
}

export async function harvestGrok(d: CodexPollerDeps): Promise<void> {
  const existing = getHarvestState<GrokState>(d.db, "grok");
  if (existing === null) {
    // History backfill: NO — collection starts from the deploy (spec, binding decision "History
    // backfill"). unified.jsonl has always been shared across ALL containers — without
    // this branch the first run after the deploy would parse and write weeks-old turns
    // (most without attribution, some wrongly assigned by the fallback correlation). Only the
    // log size is determined (WITHOUT tail — do not pull the whole history through docker just to discard it) and
    // the offset is moved straight to the end; parsing/writing starts only from the next cycle.
    const r = await runInVolume(d, GROK_VOLUME, GROK_HOME, `wc -c < ${LOG} 2>/dev/null || echo 0`);
    if (r.out === null) return; // docker/volume not working — will be retried next time
    const size = Number(r.out.trim());
    setHarvestState(d.db, "grok", { offset: Number.isFinite(size) ? size : 0, pending: [], models: {} });
    return;
  }
  const st = existing;

  // A single docker run: log size + increment from the offset (tail -c +N is 1-based).
  // `|| true` after tail: a missing log (fresh volume, nobody has run grok yet) would
  // otherwise give the shell a nonzero exit code and EVERY cycle would be reported as a docker error.
  const script = `wc -c < ${LOG} 2>/dev/null || echo 0; tail -c +${st.offset + 1} ${LOG} 2>/dev/null || true`;
  const r = await runInVolume(d, GROK_VOLUME, GROK_HOME, script);
  if (r.out === null) return; // docker/volume not working — state unchanged, read the rest next time
  const nl = r.out.indexOf("\n");
  const size = Number((nl === -1 ? r.out : r.out.slice(0, nl)).trim());
  if (!Number.isFinite(size)) return;
  if (size < st.offset) { st.offset = 0; setHarvestState(d.db, "grok", st); return; } // rotation/truncation → from zero next time
  const chunk = nl === -1 ? "" : r.out.slice(nl + 1);
  const { turns, consumedBytes } = parseUnifiedChunk(chunk);
  st.offset += consumedBytes;

  // Models of new sids (the second docker run only when needed). The sid goes through
  // SAFE_SID_RE again (defense-in-depth — parseUnifiedChunk already discarded malformed ones, here
  // it is the last barrier right before interpolation into the shell script).
  const roots = st.roots ??= {};
  const unknown = [...new Set(turns.map((t) => t.sid))].filter((s) => (!(s in st.models) || !(s in roots)) && SAFE_SID_RE.test(s));
  if (unknown.length > 0) {
    // The `; echo` at the end of EVERY lookup is unconditionally required — without a match grep prints
    // nothing (not even \n) and neither does `printf`, so the output of two neighboring sids without
    // "current_model_id" would merge into one line and the parsing below (split by lines) would
    // break them.
    const lookups = unknown.map((s) =>
      `for f in ${GROK_HOME}/sessions/*/${s}/summary.json; do [ -f "$f" ] && printf '%s\\t' '${s}' && (grep -o '"current_model_id"[^,}]*' "$f" | head -1 | tr -d '\\n'; printf '\\t'; grep -o '"git_root_dir"[^,}]*' "$f" | head -1); break; done; echo`).join("; ");
    const m = await runInVolume(d, GROK_VOLUME, GROK_HOME, lookups);
    for (const line of (m.out ?? "").split("\n")) {
      const [sid, raw, rootRaw] = line.split("\t");
      const model = raw?.match(/"current_model_id"\s*:\s*"([^"]+)"/)?.[1];
      if (sid && model) st.models[sid] = model;
      const root = rootRaw?.match(/"git_root_dir"\s*:\s*"([^"]+)"/)?.[1];
      if (sid && rootRaw !== undefined) roots[sid] = root?.match(SESSION_ROOT_RE)?.[1] ?? "";
    }
  }
  // The model cache must not grow forever — sids are limited in number over devd's lifetime, but better safe than sorry.
  const modelKeys = Object.keys(st.models);
  if (modelKeys.length > MAX_MODELS_CACHED) for (const k of modelKeys.slice(0, modelKeys.length - MAX_MODELS_CACHED)) delete st.models[k];
  const rootKeys = Object.keys(roots);
  if (rootKeys.length > MAX_MODELS_CACHED) for (const k of rootKeys.slice(0, rootKeys.length - MAX_MODELS_CACHED)) delete roots[k];

  const sidMap = getHarvestState<GrokSidMap>(d.db, "grok-sids") ?? {};
  const now = d.now();
  const rows: MetricRow[] = [];
  const stillPending: GrokState["pending"] = [];
  for (const t of [...st.pending, ...turns.map((t) => ({ ...t, firstSeenAt: now }))]) {
    const sessionId = sidMap[t.sid]?.session || roots[t.sid] || attributeGrokTurn(d.db, t.sid, t.ts, sidMap);
    if (sessionId === null && now - t.firstSeenAt < PENDING_MAX_MS) { stillPending.push(t); continue; }
    const s = sessionId ? getSession(d.db, sessionId) : null;
    // The session may have ended meanwhile (deleteSession) — getSession then returns null even
    // though we know whose turn it is. When attribution went through the grok-sids map, project/repo
    // are taken directly from it (api.ts stored them at registration, while the session was still alive);
    // a live row from getSession takes precedence if it exists.
    const mapped = sidMap[t.sid];
    const project = s?.project ?? mapped?.project ?? null;
    const repo = s?.repo ?? mapped?.repo ?? null;
    rows.push(...usageMetricRows({
      ts: t.ts, model: st.models[t.sid] ?? null, agent: "grok", sourceId: t.sid,
      session: sessionId && project !== null && repo !== null ? { id: sessionId, project, repo } : null,
      totals: t.totals, promptTokens: t.promptTokens,
    }));
  }
  if (rows.length > 0) insertMetrics(d.db, rows);
  st.pending = stillPending;
  setHarvestState(d.db, "grok", st);
}
