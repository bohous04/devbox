import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, insertMetrics, setHarvestState } from "../src/db";
import { initCodexAccounts } from "../src/codexAccountsDb";
import { auditCodexAccountStats } from "../../tools/codex-account-stats-audit";

test("production rehearsal reads disk DB and archived rollouts without changing source, dates catch-up, proves replay", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-account-audit-"));
  try {
    const path = join(root, "devd.sqlite"), volumes = join(root, "volumes");
    const day = Date.parse("2026-09-11T00:00:00+02:00");
    const db = openDb(path);
    initCodexAccounts(db);
    db.query("INSERT INTO codex_accounts(id,label,status,added_at) VALUES ('second','Private label','ready',?)").run(day - 3600000);
    setHarvestState(db, "codex", { firstRunAt: 0, sinceSec: day / 1000, files: {} });
    insertMetrics(db, [{ ts: day + 1000, session_id: null, name: "claude_code.token.usage", value: 1234,
      attrs: JSON.stringify({ "devbox.agent": "codex", "devbox.host": "devbox" }) }]);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.close();
    const before = readFileSync(path);
    mkdirSync(join(volumes, "codex-home", "_data"), { recursive: true });
    const profile = join(volumes, "codex-acct-second", "_data");
    const filename = "rollout-2026-09-10T21-00-00-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl";
    const usage = (input: number, output: number, ts: number) => JSON.stringify({
      type: "event_msg", timestamp: new Date(ts).toISOString(), payload: { type: "token_count", info: {
        total_token_usage: { input_tokens: input, output_tokens: output }, last_token_usage: { input_tokens: input },
      } },
    });
    const content = [JSON.stringify({ type: "turn_context", payload: { model: "gpt-6-astra" } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", text: "Private message should never leave volume" } }),
      usage(50, 5, day - 1000), usage(100, 10, day + 1000), ""].join("\n");
    for (const folder of ["sessions", "archived_sessions"]) {
      mkdirSync(join(profile, folder), { recursive: true });
      writeFileSync(join(profile, folder, filename), content);
    }
    const result = await auditCodexAccountStats(path, volumes, day + 3600000);
    expect(result.mode).toBe("read-only");
    expect(result.addedRows).toBe(8);
    expect(result.replayRows).toBe(0);
    expect(result.days.map(row => [row.day, row.before.tokens, row.added.tokens, row.after.tokens])).toEqual([
      ["2026-09-10", 0, 55, 55], ["2026-09-11", 1234, 55, 1289],
    ]);
    expect(result.sourceProofs).toHaveLength(2);
    expect(result.sourceProofs.every(proof => proof.bytes === Buffer.byteLength(content) && /^[a-f0-9]{64}$/.test(proof.sha256))).toBe(true);
    expect(JSON.stringify(result)).not.toContain("Private");
    expect(readFileSync(path)).toEqual(before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
