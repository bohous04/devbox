// Map of Antigravity conversations (conversationId from the hook) to devbox sessions — filled
// by api.ts (harvest_state "agy-sids") from agentSessionId/agentModel in SessionStart.
export type AgySidMap = Record<string, {
  session: string; project: string; repo: string; model: string | null; ts: number;
  /** Since when (ms) each model was in effect — see api.ts session_start. Older records lack it. */
  models?: { from: number; model: string }[];
}>;

/** Model in effect at the time of a step. The transcript's `created_at` has only seconds, whereas
 *  `from` has milliseconds (hook arrival time before the first model call) — the first step after
 *  a switch within the same second would otherwise get the old model. Before the first history
 *  entry (should not happen) the first model applies; without history, `model`. */
export function modelAt(e: AgySidMap[string], ts: number): string | null {
  let m: string | null = null;
  for (const h of e.models ?? []) if (Math.floor(h.from / 1000) * 1000 <= ts) m = h.model;
  return m ?? e.models?.[0]?.model ?? e.model;
}

// Antigravity (agy) usage from transcripts on the shared antigravity-home volume —
// agy sends no telemetry (evidence gemini-pruzkum.md, Questions 7–11). ONLY conversations
// from the agy-sids map are read (filled by api.ts from the SessionStart hook); critic/headless
// conversations have no session and are not read. Modeled on grokHarvester.ts (offsets, one docker run).
import { AGY_VOLUME, runInVolume } from "./agentAuth";
import type { CodexPollerDeps } from "./codexPoller";
import { getHarvestState, getSession, insertMetrics, setHarvestState, type MetricRow } from "./db";
import { usageMetricRows, type TokenTotals } from "./harvest";

export interface AgyStep { ts: number; totals: TokenTotals; promptTokens: number }
// `skipToNewline`: a conversation whose current line is longer than the read cap
// (see MAX_CHUNK_BYTES) — bytes up to the next \n are discarded without parsing (Fix round 2).
interface AgyState { offsets: Record<string, number>; skipToNewline?: Record<string, boolean> }
const HOME = "/home/dev/.gemini";
// The id is raw data from harvest_state (api.ts stored it from the hook's conversationId) and
// is then interpolated into the docker run shell script below — defense-in-depth against
// injection, same pattern as SAFE_SID_RE in grokHarvester.ts.
const SAFE_ID = /^[0-9a-f-]+$/i;
// The transcript is content that an agent working on this repo can also write — a fixed
// separator could be hit (e.g. by quoting this source file) and the split would cut the body
// mid-line; that conversation would then get stuck at its offset forever
// (Fix round 1, item 1). Hence a per-run unique separator, not a global constant.
const sepFor = (): string => `@@@agy-${crypto.randomUUID()}@@@`;
// Cap on the read size of ONE conversation per cycle (Fix round 1, item 2) —
// without it the first run after a deploy (or after a long pause) would pull MB × hundreds
// of conversations into one string. An unfinished line at the end is not consumed
// (parseTranscriptChunk); the rest is read in later cycles.
const MAX_CHUNK_BYTES = 8 * 1024 * 1024;
const path = (id: string) => `${HOME}/antigravity-cli/brain/${id}/.system_generated/logs/transcript_full.jsonl`;

export function parseTranscriptChunk(chunk: string, now: () => number = Date.now): { steps: AgyStep[]; consumedBytes: number } {
  const steps: AgyStep[] = [];
  let consumed = 0, rest = chunk;
  while (true) {
    const nl = rest.indexOf("\n");
    if (nl === -1) break; // an unfinished line is read next time
    const line = rest.slice(0, nl); rest = rest.slice(nl + 1);
    consumed += Buffer.byteLength(line) + 1;
    let j: Record<string, unknown>;
    try { j = JSON.parse(line); } catch { continue; } // a foreign/corrupt line is not a harvest error
    if (j.type !== "PLANNER_RESPONSE") continue;
    const n = (k: string) => (typeof j[k] === "number" && Number.isFinite(j[k]) ? (j[k] as number) : 0);
    const input = n("input_tokens"), cacheRead = n("cache_read_tokens"), output = n("output_tokens");
    if (input + cacheRead + output === 0) continue; // other step types have null tokens
    const ts = Date.parse(typeof j.created_at === "string" ? j.created_at : "");
    steps.push({ ts: Number.isFinite(ts) ? ts : now(), totals: { input, cacheRead, cacheWrite: 0, output }, promptTokens: input + cacheRead });
  }
  return { steps, consumedBytes: consumed };
}

export async function harvestAgy(d: CodexPollerDeps, maxChunkBytes: number = MAX_CHUNK_BYTES): Promise<void> {
  const map = getHarvestState<AgySidMap>(d.db, "agy-sids") ?? {};
  const ids = Object.keys(map).filter((id) => SAFE_ID.test(id));
  if (ids.length === 0) return;
  const st = getHarvestState<AgyState>(d.db, "agy-harvest") ?? { offsets: {} };
  // One docker run: for each conversation a separator, size and the increment since the offset
  // (via maxChunkBytes — the next cycle reads the rest). The separator is ONE for
  // this whole run (the same for all conversations in it), not a global constant.
  const sep = sepFor();
  const script = ids.map((id) => {
    const off = st.offsets[id] ?? 0;
    return `echo '${sep} ${id}'; wc -c < '${path(id)}' 2>/dev/null || echo 0; tail -c +${off + 1} '${path(id)}' 2>/dev/null | head -c ${maxChunkBytes} || true`;
  }).join("; ");
  const r = await runInVolume(d, AGY_VOLUME, HOME, script);
  if (r.out === null) return; // docker/volume not working — state unchanged, read next time
  const rows: MetricRow[] = [];
  for (const part of r.out.split(`${sep} `).slice(1)) {
    const nl1 = part.indexOf("\n"); if (nl1 === -1) continue;
    const id = part.slice(0, nl1).trim(); if (!SAFE_ID.test(id) || !(id in map)) continue;
    const body = part.slice(nl1 + 1);
    const nl2 = body.indexOf("\n");
    const size = Number((nl2 === -1 ? body : body.slice(0, nl2)).trim());
    if (!Number.isFinite(size)) continue;
    const off = st.offsets[id] ?? 0;
    if (size < off) {
      // Truncated/new file → from zero next time. The old skipToNewline flag referred
      // to the PREVIOUS (now invalid) content — without clearing it the next cycle would
      // also discard the first line of the new file (possibly a PLANNER_RESPONSE with tokens).
      st.offsets[id] = 0;
      if (st.skipToNewline) delete st.skipToNewline[id];
      continue;
    }
    let chunk = nl2 === -1 ? "" : body.slice(nl2 + 1);
    let advance = 0;
    if (st.skipToNewline?.[id]) {
      // Carry-over from the last cycle: this line is too long for us to safely
      // parse it whole — bytes up to the first \n are discarded unread.
      const nl = chunk.indexOf("\n");
      if (nl === -1) { st.offsets[id] = off + Buffer.byteLength(chunk); continue; } // still no end — keep waiting
      advance = Buffer.byteLength(chunk.slice(0, nl + 1));
      chunk = chunk.slice(nl + 1);
      delete st.skipToNewline[id];
    }
    const { steps, consumedBytes } = parseTranscriptChunk(chunk, d.now);
    const chunkBytes = Buffer.byteLength(chunk);
    if (consumedBytes === 0 && chunkBytes > 0 && chunkBytes >= maxChunkBytes) {
      // The whole cap was read and not a single \n → one transcript line is longer than
      // the cap. Lines this large are tool outputs, not
      // PLANNER_RESPONSE with tokens — losing this one line is fine, it just
      // has to be skipped entirely (across any number of further cycles), otherwise
      // the conversation would stay stuck on it forever.
      st.offsets[id] = off + advance + chunkBytes;
      (st.skipToNewline ??= {})[id] = true;
      continue;
    }
    st.offsets[id] = off + advance + consumedBytes;
    const m = map[id]!;
    // `model` is an untrusted display text field from the hook — it enters only as a
    // metrics label (usageMetricRows → attrs.model), never into a shell script.
    const live = getSession(d.db, m.session);
    for (const s of steps) rows.push(...usageMetricRows({
      ts: s.ts, model: modelAt(m, s.ts), agent: "agy", sourceId: id,
      session: { id: m.session, project: live?.project ?? m.project, repo: live?.repo ?? m.repo },
      totals: s.totals, promptTokens: s.promptTokens,
    }));
  }
  // Offsets and pending skip flags only for conversations that are still in the map
  // (the map holds the ~200 newest).
  st.offsets = Object.fromEntries(Object.entries(st.offsets).filter(([id]) => id in map));
  if (st.skipToNewline) st.skipToNewline = Object.fromEntries(Object.entries(st.skipToNewline).filter(([id]) => id in map));
  // Atomically: metrics and the offset advance belong together — failure of one without the other
  // would on the next cycle either duplicate rows (offset not written) or lose them
  // (offset written, metrics not). Same pattern as codexHarvester.ts.
  d.db.transaction(() => {
    if (rows.length) insertMetrics(d.db, rows);
    setHarvestState(d.db, "agy-harvest", st);
  })();
}
