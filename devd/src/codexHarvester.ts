// Codex sends no telemetry; usage is in rollout files on the codex-home volume:
// the token_count event carries CUMULATIVE total_token_usage. The harvester finds files
// changed since last time, reads the actual JSON events in order and writes DELTAS
// of individual usage checkpoints against the stored state. Attribution: the rollout id arrives in
// hook events as notify_log.agent_session_id (verified live 2026-08-25). A subagent
// (thread_spawn) sends no hook events — it inherits attribution from its parent via
// session_meta.source.subagent.thread_spawn.parent_thread_id.
import type { Database } from "bun:sqlite";
import { CODEX_VOLUME, runInVolume } from "./agentAuth";
import type { CodexPollerDeps } from "./codexPoller";
import { getHarvestState, getSession, insertMetrics, setHarvestState, type MetricRow } from "./db";
import { usageMetricRows, type TokenTotals } from "./harvest";
import { codexAccountVolume } from "./codexAccountProfiles";
import { listCodexAccounts } from "./codexAccountsDb";

const CODEX_HOME = "/home/dev/.codex";
// Retain cumulative baselines when sessions go quiet. A count/age eviction would
// recount their full histories after resume or discovery in another profile.
export const CODEX_STATE_VERSION = 1;
const OVERLAP_SEC = 120;             // mtime margin: read time must not lose anything

export interface CodexState {
  schemaVersion?: number;
  sinceSec: number;
  // Epoch seconds of the very first run (deploy). Distinguishes a rollout that existed BEFORE
  // the deploy and first appears in the state (baseline, no rows) from a genuinely
  // new rollout — see harvestCodex below.
  firstRunAt: number;
  // Keep rollout identities global, but scan clocks per profile. Discovering a
  // second profile must not reuse the default profile's recent mtime watermark.
  sources?: Record<string, { sinceSec: number; firstRunAt: number }>;
  files: Record<string, {
    totals: TokenTotals; model: string | null; session: string | null;
    // project/repo are cached RIGHT at the first successful attribution (getSession still
    // sees the session at that time) — a later cycle after deleteSession would otherwise lose the attribution.
    project: string | null; repo: string | null; updatedAt: number;
    // Parent thread of a subagent. Attribution is resolved through it even in a later cycle.
    parentId?: string;
    modelRefreshVersion?: number;
    checkpointCount?: number; lastCheckpoint?: string; lastEventTs?: number;
  }>;
}

export function totalsDelta(prev: TokenTotals | undefined, cur: TokenTotals): TokenTotals | null {
  if (!prev) return cur;
  const d = {
    input: cur.input - prev.input, cacheRead: cur.cacheRead - prev.cacheRead,
    cacheWrite: cur.cacheWrite - prev.cacheWrite, output: cur.output - prev.output,
  };
  if (d.input < 0 || d.cacheRead < 0 || d.cacheWrite < 0 || d.output < 0) return cur; // reset (a new file with the same id does not arise, but the defence is cheap)
  if (d.input === 0 && d.cacheRead === 0 && d.cacheWrite === 0 && d.output === 0) return null;
  return d;
}

// The rollout name carries its own creation timestamp: rollout-2026-08-22T23-31-35-<uuid>.jsonl.
// Used to distinguish a rollout that existed BEFORE the deploy from a genuinely new one
// (see harvestCodex, "History backfill: NO"). Deliberately separate from ID_RE — ID_RE stays
// lenient (just the format skeleton), TS_RE is strict only where the shape matters.
const ID_RE = /rollout-[\d T:-]*-([0-9a-f-]{36})\.jsonl$/;
const TS_RE = /rollout-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-[0-9a-f-]{36}\.jsonl$/;

function parseRolloutTs(line: string): number | null {
  const m = line.match(TS_RE);
  if (!m) return null; // unparsable name — treated as OLD (safer than risking a doubled cumulative)
  const t = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`);
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

export interface CodexCheckpoint { totals: TokenTotals; model: string | null; promptTokens?: number; ts?: number }
export interface CodexScanSnap {
  rolloutId: string; totals: TokenTotals; model: string | null; rolloutTs: number | null;
  checkpoints: CodexCheckpoint[]; parentId?: string;
}

// Runs beside the volume: only allowlisted metadata leaves the container. JSON
// shape checks prevent quoted turn_context text in prompts from becoming a model.
export const CODEX_SCAN_PY = String.raw`
import hashlib, json, math, os, re, sys
root, since, refresh = sys.argv[1], float(sys.argv[2]), set(json.loads(sys.argv[3]))
proofs = len(sys.argv) > 4 and sys.argv[4] == "--proofs"
name_re = re.compile(r"rollout-[\d T:-]*-([0-9a-f-]{36})\.jsonl$")
directories = (entry for folder in ("sessions", "archived_sessions") for entry in os.walk(os.path.join(root, folder)))
for directory, _, names in directories:
    for name in sorted(names):
        match = name_re.fullmatch(name)
        if not match:
            continue
        path = os.path.join(directory, name)
        try:
            if os.stat(path).st_mtime < since and match.group(1) not in refresh:
                continue
            metadata = []
            sha, size = hashlib.sha256(), 0
            with open(path, "rb") as source:
                for raw in source:
                    if proofs:
                        sha.update(raw)
                        size += len(raw)
                    line = raw.decode("utf-8")
                    if '"turn_context"' not in line and '"token_count"' not in line and '"session_meta"' not in line:
                        continue
                    try:
                        event = json.loads(line)
                    except (ValueError, UnicodeError):
                        continue
                    if not isinstance(event, dict):
                        continue
                    payload = event.get("payload")
                    if not isinstance(payload, dict):
                        continue
                    if event.get("type") == "session_meta":
                        source = payload.get("source")
                        spawn = source.get("subagent") if isinstance(source, dict) else None
                        spawn = spawn.get("thread_spawn") if isinstance(spawn, dict) else None
                        parent = spawn.get("parent_thread_id") if isinstance(spawn, dict) else None
                        if isinstance(parent, str) and re.fullmatch(r"[0-9a-f-]{36}", parent):
                            metadata.append(json.dumps({"type": "session_meta", "payload": {"parent_thread_id": parent}}))
                        continue
                    context = payload if event.get("type") == "turn_context" else None
                    if event.get("type") == "response_item" and payload.get("type") == "turn_context":
                        context = payload.get("payload")
                    if isinstance(context, dict) and isinstance(context.get("model"), str):
                        metadata.append(json.dumps({"type": "turn_context", "payload": {"model": context["model"]}}))
                    if event.get("type") != "event_msg" or payload.get("type") != "token_count":
                        continue
                    info = payload.get("info")
                    if not isinstance(info, dict) or not isinstance(info.get("total_token_usage"), dict):
                        continue
                    clean = {}
                    for field in ("total_token_usage", "last_token_usage"):
                        usage = info.get(field)
                        if isinstance(usage, dict):
                            clean[field] = {key: usage[key] if isinstance(usage[key], (int, float)) and not isinstance(usage[key], bool) and math.isfinite(usage[key]) and usage[key] >= 0 else None for key in ("input_tokens", "cached_input_tokens", "cache_write_input_tokens", "output_tokens") if key in usage}
                    metadata.append(json.dumps({"type": "event_msg", "timestamp": event.get("timestamp"), "payload": {"type": "token_count", "info": clean}}))
            print("== " + path)
            print("\n".join(metadata))
            if proofs:
                print(json.dumps({"type": "codex_scan_proof", "path": path, "bytes": size, "sha256": sha.hexdigest()}))
        except (OSError, UnicodeError):
            continue
`;

export function parseCodexScan(out: string): CodexScanSnap[] {
  const snaps: CodexScanSnap[] = [];
  let id: string | null = null, model: string | null = null, rolloutTs: number | null = null;
  let parentId: string | undefined;
  let checkpoints: CodexCheckpoint[] = [];
  const flush = () => {
    const last = checkpoints.at(-1);
    if (id && last) snaps.push({ rolloutId: id, totals: last.totals, model, rolloutTs, checkpoints, ...(parentId ? { parentId } : {}) });
    id = null; model = null; rolloutTs = null; parentId = undefined; checkpoints = [];
  };
  for (const line of out.split("\n")) {
    if (line.startsWith("== ")) {
      flush(); id = line.match(ID_RE)?.[1] ?? null; rolloutTs = parseRolloutTs(line);
      continue;
    }
    if (line.trim() === "" || id === null) continue;
    try {
      const j = JSON.parse(line);
      const parent = j?.type === "session_meta" ? j.payload?.parent_thread_id : undefined;
      if (typeof parent === "string" && /^[0-9a-f-]{36}$/.test(parent)) { parentId ??= parent; continue; }
      const context = j?.type === "turn_context" ? j.payload
        : j?.type === "response_item" && j.payload?.type === "turn_context" ? j.payload.payload : null;
      if (typeof context?.model === "string") model = context.model;
      const info = j?.type === "event_msg" && j.payload?.type === "token_count" ? j.payload.info : null;
      const u = info?.total_token_usage;
      if (!u || typeof u !== "object" || Array.isArray(u)) continue;
      const valid = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
      if (!valid(u.input_tokens) || !valid(u.output_tokens)) continue;
      if (["cached_input_tokens", "cache_write_input_tokens"].some((key) => Object.hasOwn(u, key) && !valid(u[key]))) continue;
      const cached = u.cached_input_tokens ?? 0, written = u.cache_write_input_tokens ?? 0;
      if (cached + written > u.input_tokens) continue;
      const prompt = info.last_token_usage?.input_tokens;
      const ts = typeof j.timestamp === "string" ? Date.parse(j.timestamp) : NaN;
      checkpoints.push({
        totals: { input: u.input_tokens - cached - written, cacheRead: cached, cacheWrite: written, output: u.output_tokens },
        model,
        ...(typeof prompt === "number" && Number.isFinite(prompt) && prompt >= 0 ? { promptTokens: prompt } : {}),
        ...(Number.isFinite(ts) ? { ts } : {}),
      });
    } catch { /* foreign or incomplete line */ }
  }
  flush();
  return snaps;
}

const checkpointKey = (checkpoint: CodexCheckpoint) => JSON.stringify([checkpoint.totals, checkpoint.ts ?? null]);

function checkpointDeltas(snap: CodexScanSnap, previous: TokenTotals | undefined, resumeIndex?: number): CodexCheckpoint[] {
  if (resumeIndex === undefined && previous && totalsDelta(previous, snap.totals) === null) return [];
  // A full scan includes old checkpoints. Resume after the last persisted total,
  // including when totals reset later in the same file.
  const index = resumeIndex ?? (previous ? snap.checkpoints.findLastIndex((p) => totalsDelta(previous, p.totals) === null) : -1);
  let cursor = previous;
  let seekingPrevious = resumeIndex === undefined && previous !== undefined && index === -1;
  const result: CodexCheckpoint[] = [];
  for (const checkpoint of snap.checkpoints.slice(index + 1)) {
    if (seekingPrevious && cursor && Object.keys(cursor).some((key) => checkpoint.totals[key as keyof TokenTotals] < cursor![key as keyof TokenTotals])) continue;
    seekingPrevious = false;
    const delta = totalsDelta(cursor, checkpoint.totals);
    if (delta) result.push({ ...checkpoint, totals: delta });
    cursor = checkpoint.totals;
  }
  // Truncated/reset files may no longer contain the old checkpoint.
  if (result.length === 0 && resumeIndex === undefined) {
    const delta = totalsDelta(previous, snap.totals);
    if (delta) result.push({ ...snap.checkpoints.at(-1)!, totals: delta });
  }
  return result;
}

function attributeCodex(db: Database, rolloutId: string): string | null {
  const r = db.query(`SELECT session_id FROM notify_log WHERE agent_session_id = ? ORDER BY id DESC LIMIT 1`)
    .get(rolloutId) as { session_id: string } | null;
  return r?.session_id ?? null;
}

type Attribution = { session: string; project: string | null; repo: string | null };

/** Session threads, for a subagent inherited from the nearest attributed ancestor.
 *  The ancestor's project/repo from the stored state survive even a deleted session. */
export function resolveCodexAttribution(db: Database, files: CodexState["files"], rolloutId: string, parentId?: string): Attribution | null {
  const seen = new Set<string>();
  let id: string | undefined = rolloutId, parent = parentId;
  while (id && !seen.has(id) && seen.size < 16) {
    seen.add(id);
    const known: CodexState["files"][string] | undefined = files[id];
    if (known?.session) return { session: known.session, project: known.project, repo: known.repo };
    const session = attributeCodex(db, id);
    if (session) return { session, project: null, repo: null };
    id = parent ?? known?.parentId; parent = undefined;
  }
  return null;
}

export interface CodexHarvesterDeps extends CodexPollerDeps {
  accountId?: string;
  registeredAt?: number;
  // Same metadata-only scanner, injected by the read-only audit and fixtures.
  scan?: (volume: string, sinceSec: number, refresh: string[]) => Promise<string | null>;
}

/** All registered profiles retain usage, including disabled accounts. Disabling
 * login selection does not discard historical or still-running session usage. */
export async function harvestCodexAccounts(d: CodexHarvesterDeps): Promise<void> {
  let available: Set<string> | undefined;
  if (!d.scan) {
    const result = await d.run(["volume", "ls", "--format", "{{.Name}}"]);
    if (result.code !== 0) throw new Error("Could not look up profiles for Codex statistics.");
    available = new Set(result.stdout.split(/\r?\n/).map(value => value.trim()));
  }
  const accounts = listCodexAccounts(d.db);
  const ids = new Set<string>();
  for (const account of [{ id: "default", added_at: 0 }, ...accounts]) {
    if (ids.has(account.id)) continue;
    ids.add(account.id);
    let volume: string;
    try { volume = codexAccountVolume(account.id); } catch { continue; }
    if (available && !available.has(volume)) continue; // never create missing volumes by reading
    await harvestCodex({ ...d, volume, accountId: account.id, registeredAt: account.added_at });
  }
}

export async function harvestCodex(d: CodexHarvesterDeps): Promise<void> {
  const nowSec = Math.floor(d.now() / 1000);
  const existing = getHarvestState<CodexState>(d.db, "codex");
  const st = existing ?? { sinceSec: nowSec, firstRunAt: nowSec, files: {} };
  // Old state (persisted before this fix) has no firstRunAt at all — 0 keeps the
  // existing behaviour (no rollout is baselined), because it is a safe lower bound.
  const accountId = d.accountId ?? "default";
  const source = accountId === "default" ? null : st.sources?.[accountId];
  // A newly discovered account is recovered from enrollment, rather than silently
  // baselining away all work performed before this collector was fixed.
  const firstRunAt = accountId === "default" ? (st.firstRunAt ?? 0)
    : (source?.firstRunAt ?? Math.floor((d.registeredAt ?? d.now()) / 1000));
  const sinceSec = accountId === "default" ? st.sinceSec : (source?.sinceSec ?? 0);

  // Refresh known null models once per successfully read file, including inactive
  // files. Missing/unreadable files retry; unresolved but valid files do not
  // incur an unbounded full-file scan on every poll. Unknown
  // old files still obey the normal firstRunAt baseline; no historical backfill.
  const migrating = (st.schemaVersion ?? 0) < CODEX_STATE_VERSION;
  const refresh = Object.keys(st.files).filter((id) => st.files[id].model === null
    && (st.files[id].modelRefreshVersion ?? 0) < CODEX_STATE_VERSION);
  if (migrating) for (const file of Object.values(st.files)) {
    // Prior input totals included cache writes; preserve the cumulative baseline
    // under the corrected mutually exclusive token categories.
    file.totals.input = Math.max(0, file.totals.input - file.totals.cacheWrite);
  }
  const quote = (value: string) => "'" + value.replace(/'/g, "'\"'\"'") + "'";
  const scanSince = Math.max(0, sinceSec - OVERLAP_SEC);
  const script = `python3 - ${quote(CODEX_HOME)} ${scanSince} ${quote(JSON.stringify(refresh))} <<'CODEX_SCAN_PY'
${CODEX_SCAN_PY}
CODEX_SCAN_PY`;
  const volume = d.volume ?? CODEX_VOLUME;
  const r = d.scan ? { out: await d.scan(volume, scanSince, refresh) }
    : await runInVolume({ ...d, run: (cmd) => {
      const readonly = [...cmd];
      readonly[readonly.indexOf("-v") + 1] += ":ro,nocopy";
      return d.run(readonly);
    } }, volume, CODEX_HOME, script);
  if (r.out === null) return;

  const rows: MetricRow[] = [];
  for (const snap of parseCodexScan(r.out)) {
    const prev = st.files[snap.rolloutId];
    if (prev === undefined && accountId !== "default" && snap.checkpoints.some(checkpoint => checkpoint.ts === undefined)) {
      throw new Error("Codex history cannot be restored without usage event timestamps.");
    }
    const last = snap.checkpoints.at(-1)!;
    const resumeIndex = prev?.checkpointCount && prev.lastCheckpoint
      && snap.checkpoints[prev.checkpointCount - 1]
      && checkpointKey(snap.checkpoints[prev.checkpointCount - 1]) === prev.lastCheckpoint
      ? prev.checkpointCount - 1 : undefined;
    // An older copy of a globally identical rollout in another account must not
    // roll the cumulative baseline back and make a later scan count it twice.
    if (prev?.lastEventTs !== undefined && last.ts !== undefined
      && last.ts <= prev.lastEventTs && resumeIndex === undefined) continue;
    const parentId = snap.parentId ?? prev?.parentId;
    const inherited = prev?.session ? null : resolveCodexAttribution(d.db, st.files, snap.rolloutId, parentId);
    const sessionId = prev?.session ?? inherited?.session ?? null;
    // Attribution is read NOW (while getSession still sees the session) and cached into
    // the state — otherwise a later deleteSession (session ended) would deprive
    // future cycles of project/repo, even though we know whose rollout it is (see below).
    const live = sessionId ? getSession(d.db, sessionId) : null;
    const project = live?.project ?? prev?.project ?? inherited?.project ?? null;
    const repo = live?.repo ?? prev?.repo ?? inherited?.repo ?? null;

    // A rollout that existed BEFORE the deploy and first appears in the state (prev
    // missing): its cumulative is NOT new usage since the deploy, it is the file's whole
    // history. Without this branch totalsDelta(undefined, cur) would write the whole
    // cumulative as a single delta — violating "History backfill: NO" (spec).
    // Recognised by the timestamp in the file NAME; a genuinely new rollout (created
    // only AFTER the deploy) keeps the normal behaviour (the whole cur = really new usage).
    const isPreDeployBaseline = prev === undefined && (snap.rolloutTs === null || snap.rolloutTs < firstRunAt)
      && !(accountId !== "default" && last.ts !== undefined && last.ts >= firstRunAt * 1000);

    st.files[snap.rolloutId] = { totals: snap.totals, model: snap.model ?? prev?.model ?? null, session: sessionId, project, repo, updatedAt: d.now(), modelRefreshVersion: CODEX_STATE_VERSION,
      ...(parentId ? { parentId } : {}),
      checkpointCount: snap.checkpoints.length, lastCheckpoint: checkpointKey(last), lastEventTs: last.ts };
    if (isPreDeployBaseline) continue;

    for (const checkpoint of checkpointDeltas(snap, prev?.totals, resumeIndex)) {
      if (prev === undefined && accountId !== "default" && checkpoint.ts !== undefined && checkpoint.ts < firstRunAt * 1000) continue;
      rows.push(...usageMetricRows({
        ts: checkpoint.ts ?? d.now(), model: checkpoint.model ?? snap.model ?? prev?.model ?? null,
        session: sessionId && project !== null && repo !== null ? { id: sessionId, project, repo } : null,
        totals: checkpoint.totals, promptTokens: checkpoint.promptTokens,
        agent: "codex", sourceId: snap.rolloutId,
      }));
    }
  }
  if (accountId === "default") st.sinceSec = nowSec;
  else (st.sources ??= {})[accountId] = { sinceSec: nowSec, firstRunAt };
  st.schemaVersion = CODEX_STATE_VERSION;
  d.db.transaction(() => {
    if (rows.length > 0) insertMetrics(d.db, rows);
    setHarvestState(d.db, "codex", st);
  })();
}
