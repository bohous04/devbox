#!/usr/bin/env bun
// Read-only production rehearsal. The actual collector writes into :memory:;
// the source database is opened readonly, and rollouts are read by Python only.
// No auth files, prompts, responses, Docker containers, or service changes.
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { openDb, insertNotifyLog, insertSession, setHarvestState, getHarvestState, type SessionRow } from "../devd/src/db";
import { initCodexAccounts, listCodexAccounts } from "../devd/src/codexAccountsDb";
import { CODEX_SCAN_PY, harvestCodexAccounts, parseCodexScan, type CodexHarvesterDeps } from "../devd/src/codexHarvester";

const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
type Metric = { ts: number; name: string; value: number; a_model: string | null; attrs?: string };
type DayTotal = { tokens: number; apiEstimateUsd: number };

export async function auditCodexAccountStats(dbPath: string, volumesRoot = "/var/lib/docker/volumes", now = Date.now(), timeZone = "Europe/Prague") {
  const source = new Database(dbPath, { readonly: true, create: false });
  const memory = openDb(":memory:");
  const date = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const perDay = (rows: Metric[]) => {
    const totals: Record<string, DayTotal> = {};
    for (const row of rows) {
      const day = date.format(new Date(row.ts));
      const entry = totals[day] ??= { tokens: 0, apiEstimateUsd: 0 };
      if (row.name === "claude_code.token.usage") entry.tokens += row.value;
      if (row.name === "claude_code.cost.usage") entry.apiEstimateUsd += row.value;
    }
    return totals;
  };
  try {
    initCodexAccounts(memory);
    source.exec("BEGIN");
    const accounts = source.query("SELECT id,status,disabled,added_at FROM codex_accounts ORDER BY added_at,id").all() as Array<{ id: string; status: string; disabled: number; added_at: number }>;
    for (const account of accounts) memory.query("INSERT OR REPLACE INTO codex_accounts(id,label,status,disabled,added_at) VALUES (?,?,?,?,?)")
      .run(account.id, account.id, account.status, account.disabled, account.added_at);
    const state = getHarvestState(source, "codex");
    if (state !== null) setHarvestState(memory, "codex", state);
    for (const session of source.query("SELECT id,folder,project,repo,container,port_base,status,solo,created_at,last_active_at,important FROM sessions").all() as SessionRow[]) insertSession(memory, session);
    // Attribution metadata only; notification detail and user-facing names stay on the server.
    for (const row of source.query(`SELECT n.agent_session_id,n.session_id,n.ts FROM notify_log n
      JOIN (SELECT MAX(id) id FROM notify_log WHERE agent_session_id IS NOT NULL GROUP BY agent_session_id) latest ON latest.id=n.id`).all() as Array<{ agent_session_id: string; session_id: string; ts: number }>) {
      insertNotifyLog(memory, { ...row, event: "audit", decision: "none", reason: null, inflight: 0, teammates: 0, detail: null });
    }
    const earliest = Math.min(now, ...accounts.filter(account => account.id !== "default").map(account => account.added_at));
    const baseline = source.query(`SELECT ts,name,value,a_model FROM metrics WHERE ts>=?
      AND name IN ('claude_code.token.usage','claude_code.cost.usage')
      AND json_extract(attrs,'$."devbox.agent"')='codex'`).all(earliest - 86_400_000) as Metric[];
    const highWater = source.query("SELECT MAX(id) id FROM metrics").get();
    source.exec("COMMIT");

    const snapshots = new Map<string, string>();
    const proofs: Array<{ volume: string; path: string; bytes: number; sha256: string }> = [];
    const scanSummary: Array<{ volume: string; sinceSec: number; rollouts: number }> = [];
    const absentVolumes: string[] = [];
    const deps: CodexHarvesterDeps = {
      db: memory, now: () => now,
      run: async () => { throw new Error("Docker is disabled in the read-only audit"); },
      fetch: (async () => { throw new Error("Network is disabled in the read-only audit"); }) as unknown as typeof fetch,
      scan: async (volume, sinceSec, refresh) => {
        // Replay the exact first-pass metadata on pass two, even if a live agent appends.
        if (snapshots.has(volume)) return snapshots.get(volume)!;
        const root = join(volumesRoot, volume, "_data");
        if (!existsSync(root)) { absentVolumes.push(volume); return null; }
        const process = Bun.spawn(["python3", "-c", CODEX_SCAN_PY, root, String(sinceSec), JSON.stringify(refresh), "--proofs"], { stdout: "pipe", stderr: "pipe" });
        const [out, code] = await Promise.all([new Response(process.stdout).text(), process.exited]);
        if (code !== 0) throw new Error(`Metadata scanner failed for ${volume} (exit ${code})`);
        snapshots.set(volume, out);
        scanSummary.push({ volume, sinceSec, rollouts: parseCodexScan(out).length });
        for (const line of out.split("\n")) {
          if (!line.startsWith('{"type": "codex_scan_proof"')) continue;
          const proof = JSON.parse(line);
          proofs.push({ volume, path: proof.path, bytes: proof.bytes, sha256: proof.sha256 });
        }
        return out;
      },
    };
    await harvestCodexAccounts(deps);
    const additions = memory.query("SELECT ts,name,value,a_model,attrs FROM metrics ORDER BY id").all() as Metric[];
    const afterState = getHarvestState(memory, "codex");
    const countBeforeReplay = additions.length;
    await harvestCodexAccounts(deps);
    const replayRows = (memory.query("SELECT COUNT(*) n FROM metrics").get() as { n: number }).n - countBeforeReplay;
    if (replayRows !== 0) throw new Error(`Unsafe replay: ${replayRows} duplicate rows`);
    const beforeByDay = perDay(baseline), addedByDay = perDay(additions);
    const days = Object.keys(addedByDay).sort().map(day => ({ day,
      before: beforeByDay[day] ?? { tokens: 0, apiEstimateUsd: 0 }, added: addedByDay[day],
      after: { tokens: (beforeByDay[day]?.tokens ?? 0) + addedByDay[day].tokens,
        apiEstimateUsd: (beforeByDay[day]?.apiEstimateUsd ?? 0) + addedByDay[day].apiEstimateUsd },
    }));
    return {
      mode: "read-only", at: new Date(now).toISOString(), timeZone, dbPath, highWater,
      accounts: listCodexAccounts(memory).map(account => ({ id: account.id, disabled: account.disabled, addedAt: account.added_at })),
      scanSummary, absentVolumes, days, addedRows: additions.length, replayRows,
      metricsSha256: sha(additions), beforeStateSha256: sha(state), afterStateSha256: sha(afterState), sourceProofs: proofs,
    };
  } finally { memory.close(); source.close(); }
}

if (import.meta.main) {
  const [dbPath, volumesRoot] = process.argv.slice(2);
  if (!dbPath) throw new Error("Usage: bun tools/codex-account-stats-audit.ts DATABASE [DOCKER_VOLUMES_ROOT] (always read-only)");
  console.log(JSON.stringify(await auditCodexAccountStats(dbPath, volumesRoot), null, 2));
}
