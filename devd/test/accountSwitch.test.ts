import { expect, test } from "bun:test";
import { switchAccount, type SwitchAccountDeps } from "../src/accountSwitch";
import { AGENT_IDS, AGENTS } from "../src/agents";
import type { ExecResult } from "../src/ccUpkeep";
import { ACCOUNT_POOL_DEFAULTS } from "../src/config";
import {
  insertAccount, insertLease, insertSession, leaseHistory, openDb, upsertAccountUsage,
  type AccountUsageRow, type SessionRow,
} from "../src/db";

const HOUR = 3600_000;
const NOW = 1_800_000_000_000;

const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "", timedOut: false });
const fail = (): ExecResult => ({ code: 1, stdout: "", stderr: "no such container", timedOut: false });

// Raw (NUL-separated) contents of /proc/<pid>/environ as `cat` sees it — simulates
// the answer to the probe from accountSwitch.ts (paneConfigDir), which switchAccount now
// calls ALWAYS (even for "unchanged"), not only on an actual restart.
const environOf = (configDir: string): string =>
  `PATH=/usr/bin\0CLAUDE_CONFIG_DIR=${configDir}\0HOME=/home/dev\0`;

const ROW: SessionRow = {
  id: "dev-shop-cms", folder: "acme", project: "shop", repo: "cms", container: "dev-shop-cms",
  port_base: 40100, status: "running", solo: 0, created_at: 0, last_active_at: 0, important: 0, agent: "claude",
};

const usage = (id: string, five: number, over: Partial<AccountUsageRow> = {}): AccountUsageRow => ({
  account_id: id, five_hour_pct: five, five_hour_resets_at: NOW + HOUR,
  seven_day_pct: 10, seven_day_resets_at: NOW + 10 * HOUR,
  limits_json: null, fetched_at: NOW, error: null, ...over,
});

function baseDb() {
  const db = openDb(":memory:");
  insertAccount(db, { id: "primary", label: "primary@x.cz", disabled: 0, quarantined_at: null, added_at: 1 });
  insertAccount(db, { id: "backup", label: "backup@x.cz", disabled: 0, quarantined_at: null, added_at: 2 });
  upsertAccountUsage(db, usage("primary", 95));   // over the threshold
  upsertAccountUsage(db, usage("backup", 20));    // free
  return db;
}

function deps(over: Partial<SwitchAccountDeps> = {}): SwitchAccountDeps {
  // Policy/lease tests share a realistic native resume lifecycle. Exact-resume
  // failures and real filesystem probes are covered in claudeAccountResume.test.
  const exec = over.exec ?? (async () => ok());
  const exited = new Set<string>();
  const resumed = new Map<number, { account: string; id: string }>();
  const idFor = (target: string) => target === "main-3:0.0" ? "22222222-2222-2222-2222-222222222222" : "11111111-1111-1111-1111-111111111111";
  return {
    db: baseDb(),
    sleep: async () => {},
    settings: () => ACCOUNT_POOL_DEFAULTS,
    now: () => NOW,
    inFlight: new Set<string>(),
    ...over,
    exec: async (container, cmd, timeout) => {
      if (cmd[0] === "python3" && cmd[2]?.startsWith("# CLAUDE_RESUME_PREFLIGHT")) return ok(JSON.stringify({ boundaryNs: "1000" }));
      if (cmd[0] === "python3" && cmd[2]?.startsWith("# CLAUDE_RESUME_TRANSCRIPT")) return ok("ok");
      if (cmd[0] === "tmux" && cmd[1] === "send-keys") {
        if (cmd[4] === "/exit") exited.add(cmd[3]!);
        const match = cmd[4]?.match(/export CLAUDE_CONFIG_DIR=(\S+); cc --resume ([0-9a-f-]+)/);
        if (match) resumed.set(cmd[3] === "main-3:0.0" ? 74 : 64, { account: match[1]!, id: match[2]! });
      }
      const proc = cmd[0] === "cat" ? cmd[1]?.match(/^\/proc\/(\d+)\/(environ|cmdline)$/) : null;
      const returned = proc ? resumed.get(Number(proc[1]) - 1000) : undefined;
      if (returned) return ok(proc![2] === "environ" ? environOf(returned.account) : `claude\0--resume\0${returned.id}\0`);
      const r = await exec(container, cmd, timeout);
      if (r.code !== 0 || r.timedOut) return r;
      if (cmd[0] === "ps") return { ...r, stdout: r.stdout.replace(/(\d+)(\s+\d+\s+\d+\s+claude)/g, (all, pid, tail) => resumed.has(Number(pid)) ? `${Number(pid) + 1000}${tail}` : all) };
      if (proc?.[2] === "environ" && !r.stdout) return ok(environOf("/home/dev/.claude-accounts/primary"));
      if (cmd[0] === "tmux" && cmd[1] === "capture-pane" && !r.stdout) {
        const target = cmd[cmd.indexOf("-t") + 1]!;
        return ok(exited.has(target) ? `Resume this session with:\nclaude --resume ${idFor(target)}\n$ ` : "Current conversation");
      }
      return r;
    },
  };
}

test("unknown session → unknown-session, no exec", async () => {
  let calls = 0;
  const d = deps({ exec: async () => { calls++; return ok(); } });
  expect(await switchAccount(d, "dev-missing")).toEqual({ status: "unknown-session" });
  expect(calls).toBe(0);
});

test("stopped session → not-running, no exec", async () => {
  const db = baseDb();
  insertSession(db, { ...ROW, status: "stopped" });
  let calls = 0;
  const d = deps({ db, exec: async () => { calls++; return ok(); } });
  expect(await switchAccount(d, ROW.id)).toEqual({ status: "not-running" });
  expect(calls).toBe(0);
});

// C1 (review round 1, critical): a Codex session has nothing to do with the pool of
// Anthropic accounts (agent-launch requests a lease only for claude) — `/exit` would discard its
// running turn and bring it back as Claude on someone else's profile.
// The `agent` column is text: an old row or a typo in an API request brings here
// a value that is not in the profile table. Indexing the table with it crashed the whole request
// (500), while the earlier `=== "codex"` was total — it returned false and carried on.
// The fallback to claude restores that totality and is also factually correct: agent-launch starts
// such a session as claude too, so it really runs on an Anthropic account and the pool
// applies to it. The test therefore does not compare against a concrete result but against a claude session's behaviour.
test("an unknown profile in the DB does not crash the request — it runs as claude, same as agent-launch", async () => {
  const run = async (agent: string) => {
    const db = baseDb();
    insertSession(db, { ...ROW, agent: agent as never });
    return switchAccount(deps({ db }), ROW.id);
  };
  expect(await run("gpt-something")).toEqual(await run("claude"));
});

test("Codex session → wrong-agent, no exec (C1)", async () => {
  const db = baseDb();
  insertSession(db, { ...ROW, agent: "codex" });
  let calls = 0;
  const d = deps({ db, exec: async () => { calls++; return ok(); } });
  expect(await switchAccount(d, ROW.id)).toEqual({ status: "wrong-agent" });
  expect(calls).toBe(0);
});

test("the account pool rejects EVERY profile that does not run on an Anthropic account", async () => {
  for (const agent of AGENT_IDS.filter((a) => !AGENTS[a].anthropicAccount)) {
    const db = baseDb();
    insertSession(db, { ...ROW, id: "dev-p-r", agent, status: "running" });
    const r = await switchAccount(deps({ db }), "dev-p-r");
    expect(r.status).toBe("wrong-agent");
  }
});

test("native claude may still be switched (this must not kill today's path)", async () => {
  const db = baseDb();
  insertSession(db, { ...ROW, id: "dev-p-r", agent: "claude", status: "running" });
  const r = await switchAccount(deps({ db }), "dev-p-r");
  expect(r.status).not.toBe("wrong-agent");
});

test("no usable account (both disabled) → no-account, no exec", async () => {
  const db = openDb(":memory:");
  insertSession(db, ROW);
  insertAccount(db, { id: "primary", label: "primary@x.cz", disabled: 1, quarantined_at: null, added_at: 1 });
  let calls = 0;
  const d = deps({ db, exec: async () => { calls++; return ok(); } });
  expect(await switchAccount(d, ROW.id)).toEqual({ status: "no-account" });
  expect(calls).toBe(0);
});

// I5 (review round 1, important; REVISED — see the brief "masking by stale
// leases"): force skips cooldown/hysteresis, but can STILL return the SAME account
// the session already runs on. Previously this was detected PURELY from leases and exec was not
// called at all ("no exec" was a deliberate decision of review round 4) — but a lease is
// only a RECORD of what devd THINKS happened, not a fact about reality: the test
// "stale lease claims ... but the pane actually runs on ..." below proves that a lease
// can be fresh and STILL lie (a partially failed previous switch). The pane is
// therefore now ALWAYS verified via the actual CLAUDE_CONFIG_DIR; "unchanged" means
// "verified live, all panes are already there", not "the lease says so". Two extra execs
// on a manual operator command hurt nobody, a silent lie about the pane state does.
test("best account == current and the pane is VERIFIED on the target → unchanged, no new lease (I5)", async () => {
  const db = baseDb();
  insertSession(db, ROW);
  insertLease(db, { account_id: "backup", client: "devbox", session_id: ROW.id, label: "shop/cms", created_at: NOW - HOUR, released_at: null });
  let listPanesCalls = 0;
  const d = deps({
    db,
    exec: async (_c, cmd) => {
      if (cmd[0] === "tmux" && cmd[1] === "list-panes") { listPanesCalls++; return ok("main:0.0\t62\n"); }
      if (cmd[0] === "ps") return ok("   62    61 900 bash\n   64    62 300 claude\n");
      if (cmd[0] === "cat" && cmd[1] === "/proc/64/environ") return ok(environOf("/home/dev/.claude-accounts/backup"));
      return ok();
    },
  });
  expect(await switchAccount(d, ROW.id)).toEqual({ status: "unchanged", accountId: "backup", label: "backup@x.cz" });
  expect(listPanesCalls).toBe(1);   // verified live, not just derived from leases
  expect(leaseHistory(db, "devbox", ROW.id).length).toBe(1);   // nothing was added or released
});

// Review round 2 (important): `currentAccount(history)` is only the NEWEST row —
// main and main-2 (same sessionId, DEVD_SESSION_ID is container-level) can after
// a split really run on TWO DIFFERENT accounts (main-2 got a different account because
// main's account expired in the meantime). The newest row (main-2, backup) would under the old
// check `decision.accountId === current` look "unchanged", even though
// main still burns the exhausted primary — the alert's dev switch would silently no-op exactly
// in the case it exists for.
test("split session (main on primary, main-2 on backup) → NOT unchanged, even though the newest lease matches", async () => {
  const db = baseDb();
  insertSession(db, ROW);
  // main leased primary first (older row)…
  insertLease(db, { account_id: "primary", client: "devbox", session_id: ROW.id, label: "shop/cms", created_at: NOW - 2 * HOUR, released_at: null });
  // …and main-2 leased backup later (newest row) — currentAccount would say "backup".
  insertLease(db, { account_id: "backup", client: "devbox", session_id: ROW.id, label: "shop/cms", created_at: NOW - HOUR, released_at: null });
  const lc = pidLifecycle([62]);
  const d = deps({
    db,
    exec: async (_c, cmd) => {
      if (cmd[0] === "tmux" && cmd[1] === "list-panes") return ok("main:0.0\t62\n");
      if (cmd[0] === "tmux" && cmd[1] === "send-keys") { lc.onSendKeys(62, cmd[4] as string); return ok(); }
      if (cmd[0] === "ps") return ok(lc.ps([62]));
      return ok();
    },
  });
  const r = await switchAccount(d, ROW.id);
  expect(r.status).not.toBe("unchanged");
  expect(r.status).toBe("switched");   // main (still on primary) really restarts
});

// Complement to the previous test: `stop()` does not release the lease (only `end()` does),
// so an old session that ended long ago can have `released_at IS NULL` forever.
// ORIGINALLY (review round 3) this was about the trap of a naive `every` over ALL unreleased
// leases regardless of age — the `leaseMaxAgeMs` window prevented a ghost from outside from skewing
// the calculation. REVISED (see I5 above): "unchanged"/"switched" is today not
// derived from leases at all, so a ghost cannot skew anything, however old
// it is — the pane is verified directly. The test stays to prove it after the rebuild too:
// the ghost is here on purpose, the verification ignores it entirely, not just "outside the window".
test("a ghost lease (different account, unreleased for ages) does not affect the verified pane → unchanged", async () => {
  const db = baseDb();
  insertSession(db, ROW);
  // Ghost: different account, unreleased for ages — previously handled by the leaseMaxAgeMs window, now
  // it does not count towards the decision at all (see the comment above).
  insertLease(db, { account_id: "primary", client: "devbox", session_id: ROW.id, label: "shop/cms", created_at: NOW - 5 * HOUR, released_at: null });
  // The current, fresh lease matches what the session deserves (backup) — and the pane
  // is (verified live) really there.
  insertLease(db, { account_id: "backup", client: "devbox", session_id: ROW.id, label: "shop/cms", created_at: NOW - HOUR, released_at: null });
  let listPanesCalls = 0;
  const d = deps({
    db,
    exec: async (_c, cmd) => {
      if (cmd[0] === "tmux" && cmd[1] === "list-panes") { listPanesCalls++; return ok("main:0.0\t62\n"); }
      if (cmd[0] === "ps") return ok("   62    61 900 bash\n   64    62 300 claude\n");
      if (cmd[0] === "cat" && cmd[1] === "/proc/64/environ") return ok(environOf("/home/dev/.claude-accounts/backup"));
      return ok();
    },
  });
  expect(await switchAccount(d, ROW.id)).toEqual({ status: "unchanged", accountId: "backup", label: "backup@x.cz" });
  expect(listPanesCalls).toBe(1);
});

// Review round 3 (important; REVISED — see I5 above): `activeLeases` was
// a time estimate ("unreleased and younger than leaseMaxAgeMs"), and `leaseMaxAgeMs`
// (`autoStopHours`, the watchdog's IDLE threshold, not lease age) decided whether
// the session still "counts". A session continuously BUSY longer than this window has
// its single, still correct lease older than it — ORIGINALLY `active.length === 0`
// fell back to `current` and prevented a needless restart. Now leases are not read for this
// decision at all — the pane is ALWAYS verified, however old its last lease
// is — so the old date no longer plays a role; the test proves that the
// verification behaves the same (unchanged) even over a lease older than the former window.
test("a continuously busy session with ONE (old, but actually correct) lease → unchanged, not a restart", async () => {
  const db = baseDb();
  insertSession(db, ROW);
  // Single lease, correct account (backup), but older than the former leaseMaxAgeMs (4 h)
  // — the container has been running continuously for 5 h, the watchdog did not stop it (busy != idle).
  insertLease(db, { account_id: "backup", client: "devbox", session_id: ROW.id, label: "shop/cms", created_at: NOW - 5 * HOUR, released_at: null });
  let listPanesCalls = 0;
  const d = deps({
    db,
    exec: async (_c, cmd) => {
      if (cmd[0] === "tmux" && cmd[1] === "list-panes") { listPanesCalls++; return ok("main:0.0\t62\n"); }
      if (cmd[0] === "ps") return ok("   62    61 900 bash\n   64    62 300 claude\n");
      if (cmd[0] === "cat" && cmd[1] === "/proc/64/environ") return ok(environOf("/home/dev/.claude-accounts/backup"));
      return ok();
    },
  });
  expect(await switchAccount(d, ROW.id)).toEqual({ status: "unchanged", accountId: "backup", label: "backup@x.cz" });
  expect(listPanesCalls).toBe(1);
});

// Exact reproduction of the scenario from the brief ("masking by stale leases"): a previous
// `dev switch` restored only PART of the panes (typically "did-not-exit" on one of them),
// but because AT LEAST ONE succeeded, the DB got ONE lease row claiming "the whole
// session is on backup" — pane B however actually stayed on primary. That lease is
// FRESH (`current` and the old `active` would both say "backup"), so the ORIGINAL code
// (derived from leases) would mask this forever as "unchanged" without ever
// looking at what the pane really runs on — without recreating the session it could not be
// fixed. Verifying reality opens this up: the pane is still on primary → it is restarted,
// the DB is fixed, "unchanged" never comes out until it is actually true.
test("stale lease claims backup, but the pane actually runs on primary → NOT unchanged, the pane gets fixed", async () => {
  const db = baseDb();
  insertSession(db, ROW);
  // Lease after a previous (partially failed) switch — fresh, claims backup.
  insertLease(db, { account_id: "backup", client: "devbox", session_id: ROW.id, label: "shop/cms", created_at: NOW - 5_000, released_at: null });
  const sent: string[][] = [];
  const lc = pidLifecycle([62]);
  const d = deps({
    db,
    exec: async (_c, cmd) => {
      if (cmd[0] === "tmux" && cmd[1] === "list-panes") return ok("main:0.0\t62\n");
      if (cmd[0] === "ps") return ok(lc.ps([62]));
      // the pane is actually STILL on primary, not on backup as the lease claims
      if (cmd[0] === "cat" && cmd[1] === "/proc/64/environ") return ok(environOf("/home/dev/.claude-accounts/primary"));
      if (cmd[0] === "tmux" && cmd[1] === "send-keys") { sent.push(cmd as string[]); lc.onSendKeys(62, cmd[4] as string); return ok(); }
      return ok();
    },
  });
  const r = await switchAccount(d, ROW.id);
  expect(r.status).toBe("switched");
  if (r.status !== "switched") throw new Error("unreachable");
  expect(r.accountId).toBe("backup");
  expect(r.panes).toEqual([{ target: "main:0.0", outcome: "restarted" }]);
  expect(sent.some((c) => c[4] === "/exit")).toBe(true);   // the pane DID restart, even though the lease claimed it was already done

  const history = leaseHistory(db, "devbox", ROW.id);
  const active = history.filter((l) => l.released_at === null);
  expect(active.length).toBe(1);
  expect(active[0]!.account_id).toBe("backup");
});

// Review round 2 (minor→fixed as a guard): two concurrent calls on THE SAME session could
// send /exit into each other — the second hits a pane the first has just
// brought back into a live conversation and discards what the first has just restored too.
test("two concurrent calls on THE SAME session → the second is rejected (in-progress), does not interfere with the first", async () => {
  const db = baseDb();
  insertSession(db, ROW);
  insertLease(db, { account_id: "primary", client: "devbox", session_id: ROW.id, label: "shop/cms", created_at: NOW - HOUR, released_at: null });
  const inFlight = new Set<string>();
  let releaseFirst!: () => void;
  const gate = new Promise<void>((r) => { releaseFirst = r; });
  let listPanesCalls = 0;
  const lc = pidLifecycle([62]);
  const d = deps({
    db, inFlight,
    exec: async (_c, cmd) => {
      if (cmd[0] === "tmux" && cmd[1] === "list-panes") {
        listPanesCalls++;
        await gate;   // hold the first call "in the middle" until the test releases it
        return ok("main:0.0\t62\n");
      }
      if (cmd[0] === "tmux" && cmd[1] === "send-keys") { lc.onSendKeys(62, cmd[4] as string); return ok(); }
      if (cmd[0] === "ps") return ok(lc.ps([62]));
      return ok();
    },
  });
  const first = switchAccount(d, ROW.id);         // do NOT await — stays hanging on gate
  const second = await switchAccount(d, ROW.id);   // runs while the first is still going
  expect(second).toEqual({ status: "in-progress" });
  expect(listPanesCalls).toBe(1);   // the second call never even got to exec
  releaseFirst();
  const r1 = await first;
  expect(r1.status).toBe("switched");
});

// I2/I3 (review round 1, important): DEVD_SESSION_ID is container-level, so
// main and main-3 in THE SAME session share the sessionId — both must get the new profile,
// otherwise main-3 would keep burning the exhausted account. The restart uses THE SAME verified
// /exit→wait→--resume choreography as ccUpkeep (restartPane), so the
// simulation must (just like ccUpkeep.test.ts) track state per pid: /exit sends it
// away, `cc --resume` brings it back — ps must reflect both faithfully, otherwise
// waitForClaude waits for a state that never happens and ends with a timeout.
const PANES = "main:0.0\t62\nmain-3:0.0\t72\n";

// `pids`: which pids the simulation tracks as "has claude" at all. A pid that is not
// in `pids` (main-3 in the "pane without a live claude" test) never shows up in ps
// with a `claude` child, whatever is sent to it.
function pidLifecycle(pids: number[]) {
  const exited = new Set<number>();
  const returned = new Set<number>();
  return {
    onSendKeys(pid: number, keys: string) {
      // The launch command is `cc` / `cc --resume <id>`, possibly with the prefix
      // `export CLAUDE_CONFIG_DIR=…; ` — restartPane looks up the conversation id itself.
      if (keys === "/exit") exited.add(pid);
      else if (/(^|;\s*)cc(\s|$)/.test(keys)) returned.add(pid);
    },
    ps(allPids: number[]) {
      return allPids.map((pid) => {
        const alive = pids.includes(pid) && (returned.has(pid) || !exited.has(pid));
        return alive ? `   ${pid}    ${pid - 1} 900 bash\n   ${pid + 2}    ${pid} 300 claude\n` : `   ${pid}    ${pid - 1} 900 zsh\n`;
      }).join("");
    },
  };
}

const PID_FOR: Record<string, number> = { "main:0.0": 62, "main-3:0.0": 72 };

test("two panes (main, main-3) with the same sessionId → both restart on the new profile (I2)", async () => {
  const db = baseDb();
  insertSession(db, ROW);
  insertLease(db, { account_id: "primary", client: "devbox", session_id: ROW.id, label: "shop/cms", created_at: NOW - HOUR, released_at: null });
  const sent: string[][] = [];
  const lc = pidLifecycle([62, 72]);
  const d = deps({
    db,
    exec: async (_c, cmd) => {
      if (cmd[0] === "tmux" && cmd[1] === "list-panes") return ok(PANES);
      if (cmd[0] === "tmux" && cmd[1] === "send-keys") {
        sent.push(cmd as string[]);
        lc.onSendKeys(PID_FOR[cmd[3] as string]!, cmd[4] as string);
        return ok();
      }
      if (cmd[0] === "ps") return ok(lc.ps([62, 72]));
      return ok();
    },
  });
  const r = await switchAccount(d, ROW.id);
  expect(r.status).toBe("switched");
  if (r.status !== "switched") throw new Error("unreachable");
  expect(r.accountId).toBe("backup");
  expect(r.panes.map((p) => p.target).sort()).toEqual(["main-3:0.0", "main:0.0"]);
  expect(r.panes.every((p) => p.outcome === "restarted")).toBe(true);
  // The launch command EXPORTS CLAUDE_CONFIG_DIR to the NEW (backup) profile into the pane's
  // shell (not just as a prefix of one command) — otherwise the next bare launch of
  // cc (manual, or the nightly ccUpkeep) would silently return it to the old account, even though the DB already claims
  // the new one (review round 4, I1).
  const starts = sent.filter((c) => /(^|;\s*)cc(\s|$)/.test(c[4] as string));
  expect(starts.length).toBe(2);
  // Each pane resumes its own exact ID on the selected profile.
  expect(starts.map(c => c[4])).toEqual([
    "export CLAUDE_CONFIG_DIR=/home/dev/.claude-accounts/backup; cc --resume 11111111-1111-1111-1111-111111111111",
    "export CLAUDE_CONFIG_DIR=/home/dev/.claude-accounts/backup; cc --resume 22222222-2222-2222-2222-222222222222",
  ]);

  const history = leaseHistory(db, "devbox", ROW.id);
  expect(history.filter((l) => l.released_at === null).length).toBe(1);
  expect(history.filter((l) => l.released_at === null)[0]!.account_id).toBe("backup");
});

// I4 (review round 1, important): the DB may be written only AFTER a verified restart —
// when not a single pane can be restarted, the old lease must stay valid
// (the session still actually runs on the old account, the DB must not claim otherwise).
test("no pane can be restarted → failed, the old lease stays (I4)", async () => {
  const db = baseDb();
  insertSession(db, ROW);
  insertLease(db, { account_id: "primary", client: "devbox", session_id: ROW.id, label: "shop/cms", created_at: NOW - HOUR, released_at: null });
  const d = deps({
    db,
    exec: async (_c, cmd) => {
      if (cmd[0] === "tmux" && cmd[1] === "list-panes") return ok("main:0.0\t62\n");
      // claude never exits after /exit → did-not-exit, cc --resume is not even tried.
      if (cmd[0] === "ps") return ok("   62    61 900 bash\n   64    62 300 claude\n");
      return ok();
    },
  });
  const r = await switchAccount(d, ROW.id);
  expect(r.status).toBe("failed");
  if (r.status !== "failed") throw new Error("unreachable");
  expect(r.panes).toEqual([{ target: "main:0.0", outcome: "did-not-exit" }]);

  const history = leaseHistory(db, "devbox", ROW.id);
  expect(history.length).toBe(1);           // no new lease
  expect(history[0]!.released_at).toBeNull();  // the old one stayed active
  expect(history[0]!.account_id).toBe("primary");
});

test("container unreachable (list-panes fails) → failed, no new lease", async () => {
  const db = baseDb();
  insertSession(db, ROW);
  insertLease(db, { account_id: "primary", client: "devbox", session_id: ROW.id, label: "shop/cms", created_at: NOW - HOUR, released_at: null });
  const d = deps({ db, exec: async () => fail() });
  const r = await switchAccount(d, ROW.id);
  expect(r.status).toBe("failed");
  if (r.status !== "failed") throw new Error("unreachable");
  expect(r.panes).toEqual([]);
});

// A session with SEVERAL panes, where only one actually runs claude (the other is
// e.g. a plain shell or Codex) — only the one with claude may be touched.
test("a pane without a live claude is skipped, not touched", async () => {
  const db = baseDb();
  insertSession(db, ROW);
  insertLease(db, { account_id: "primary", client: "devbox", session_id: ROW.id, label: "shop/cms", created_at: NOW - HOUR, released_at: null });
  const sent: string[][] = [];
  const lc = pidLifecycle([62]);   // only main (62) has claude; main-3 (72) never
  const d = deps({
    db,
    exec: async (_c, cmd) => {
      if (cmd[0] === "tmux" && cmd[1] === "list-panes") return ok(PANES);
      if (cmd[0] === "ps") return ok(lc.ps([62, 72]));
      if (cmd[0] === "tmux" && cmd[1] === "send-keys") {
        sent.push(cmd as string[]);
        lc.onSendKeys(PID_FOR[cmd[3] as string]!, cmd[4] as string);
        return ok();
      }
      return ok();
    },
  });
  const r = await switchAccount(d, ROW.id);
  expect(r.status).toBe("switched");
  if (r.status !== "switched") throw new Error("unreachable");
  expect(r.panes.map((p) => p.target)).toEqual(["main:0.0"]);   // main-3 was not handled at all
  expect(sent.every((c) => c[3] === "main:0.0")).toBe(true);
});

// Fix: `restartPanes` used to restart EVERY pane with a live claude, even the one already
// running on the target profile — needlessly discarding its in-progress turn. The new probe reads
// the actual CLAUDE_CONFIG_DIR of the claude process via `cat /proc/<pid>/environ` and
// skips a pane that already has it right (outcome "already-on-account"), instead of
// sending it through /exit too.
//
// A second symptom of the same cause (see the brief): the lease in the DB is also STALE here
// (claims primary), but the pane actually runs on backup. This must not pass as
// "unchanged" just like that — if the DB were silently fixed but the answer reported
// "unchanged", the operator would not see from the return value at all that something happened
// (even though it is only a record, not a restart). Hence "switched": the DB is fixed to the
// verified reality (no pane was touched in the process — `panes` attests that via
// "already-on-account") and the next `dev switch` no longer works with the same lie.
test("a pane ALREADY on the target account is skipped (already-on-account), but a stale lease → switched (DB fix), no /exit", async () => {
  const db = baseDb();
  insertSession(db, ROW);
  insertLease(db, { account_id: "primary", client: "devbox", session_id: ROW.id, label: "shop/cms", created_at: NOW - HOUR, released_at: null });
  const sent: string[][] = [];
  const lc = pidLifecycle([62]);
  const d = deps({
    db,
    exec: async (_c, cmd) => {
      if (cmd[0] === "tmux" && cmd[1] === "list-panes") return ok("main:0.0\t62\n");
      if (cmd[0] === "ps") return ok(lc.ps([62]));
      // the claude pid is 62+2=64 (see pidLifecycle.ps) — the pane is ALREADY on backup (the target).
      if (cmd[0] === "cat" && cmd[1] === "/proc/64/environ") return ok(environOf("/home/dev/.claude-accounts/backup"));
      if (cmd[0] === "tmux" && cmd[1] === "send-keys") { sent.push(cmd as string[]); return ok(); }
      return ok();
    },
  });
  const r = await switchAccount(d, ROW.id);
  expect(r.status).toBe("switched");
  if (r.status !== "switched") throw new Error("unreachable");
  expect(r.accountId).toBe("backup");
  expect(r.panes).toEqual([{ target: "main:0.0", outcome: "already-on-account" }]);
  expect(sent.length).toBe(0);   // the pane was not touched at all — no /exit

  const history = leaseHistory(db, "devbox", ROW.id);
  const active = history.filter((l) => l.released_at === null);
  expect(active.length).toBe(1);
  expect(active[0]!.account_id).toBe("backup");   // the lease caught up with reality, not the other way round
});

test("two panes: one ALREADY on backup (skipped), the other still on primary (restarted)", async () => {
  const db = baseDb();
  insertSession(db, ROW);
  insertLease(db, { account_id: "primary", client: "devbox", session_id: ROW.id, label: "shop/cms", created_at: NOW - HOUR, released_at: null });
  const sent: string[][] = [];
  const lc = pidLifecycle([62, 72]);
  const d = deps({
    db,
    exec: async (_c, cmd) => {
      if (cmd[0] === "tmux" && cmd[1] === "list-panes") return ok(PANES);
      if (cmd[0] === "ps") return ok(lc.ps([62, 72]));
      if (cmd[0] === "cat" && cmd[1] === "/proc/64/environ") return ok(environOf("/home/dev/.claude-accounts/backup"));   // main (62): claude pid 64, ALREADY on the target
      if (cmd[0] === "cat" && cmd[1] === "/proc/74/environ") return ok(environOf("/home/dev/.claude-accounts/primary"));  // main-3 (72): claude pid 74, still the old account
      if (cmd[0] === "tmux" && cmd[1] === "send-keys") {
        sent.push(cmd as string[]);
        lc.onSendKeys(PID_FOR[cmd[3] as string]!, cmd[4] as string);
        return ok();
      }
      return ok();
    },
  });
  const r = await switchAccount(d, ROW.id);
  expect(r.status).toBe("switched");
  if (r.status !== "switched") throw new Error("unreachable");
  const byTarget = Object.fromEntries(r.panes.map((p) => [p.target, p.outcome]));
  expect(byTarget["main:0.0"]).toBe("already-on-account");
  expect(byTarget["main-3:0.0"]).toBe("restarted");
  expect(sent.every((c) => c[3] === "main-3:0.0")).toBe(true);   // main was not touched at all
});

// Fail-safe (explicitly from the brief): an unreadable pane profile (the process has
// disappeared meanwhile, /proc unavailable, empty/broken output) MUST NOT be silently read as
// "probably fine" — that would be worse than a needless restart. Therefore
// account switching now fails closed before /exit: it cannot prove continuation.
test("unreadable current account fails closed without restarting or replacing the lease", async () => {
  const db = baseDb();
  insertSession(db, ROW);
  insertLease(db, { account_id: "primary", client: "devbox", session_id: ROW.id, label: "shop/cms", created_at: NOW - HOUR, released_at: null });
  const lc = pidLifecycle([62]);
  const d = deps({
    db,
    exec: async (_c, cmd) => {
      if (cmd[0] === "tmux" && cmd[1] === "list-panes") return ok("main:0.0\t62\n");
      if (cmd[0] === "ps") return ok(lc.ps([62]));
      if (cmd[0] === "cat") return fail();   // /proc/<pid>/environ cannot be read
      if (cmd[0] === "tmux" && cmd[1] === "send-keys") { lc.onSendKeys(62, cmd[4] as string); return ok(); }
      return ok();
    },
  });
  const r = await switchAccount(d, ROW.id);
  expect(r.status).toBe("failed");
  if (r.status !== "failed") throw new Error("unreachable");
  expect(r.panes).toEqual([{ target: "main:0.0", outcome: "unknown-session" }]);
  expect(leaseHistory(db, "devbox", ROW.id).filter(l => l.released_at === null).map(l => l.account_id)).toEqual(["primary"]);
});

// All accounts over the threshold (all-exhausted): force still picks the one that frees up
// first, even if it is a different account than the current one — the CLI should warn about it, not
// hide it; `exhausted` must make it through to the result.
// I4 (final review): `project: s.project` must reach the policy via the
// `dev switch` path too, not just in the pure function `allowedAccounts` (accountPolicy.test.ts).
// The session (ROW) has project "shop" pinned to primary, which is exhausted
// (95 %, baseDb). `force: true` (manual dev switch) skips cooldown and
// hysteresis, but NOT the pin filter — that sits above them (accountPolicy.ts).
// Without the pin, force would pick the freer backup (20 %); with the pin, primary stays the only
// candidate and falls into the all-exhausted branch. If `switchAccount` sent
// `project: null` instead of `s.project` (exactly the mutation from the brief), the pin would
// not apply and the test would fail with "switched"/backup instead of "unchanged"/primary.
test("dev switch respects the project pin, force does not bypass it (I4)", async () => {
  const db = baseDb();   // primary 95 % (exhausted), backup 20 % (free)
  insertSession(db, ROW);   // project: "shop"
  insertLease(db, { account_id: "primary", client: "devbox", session_id: ROW.id, label: "shop/cms", created_at: NOW - HOUR, released_at: null });
  const sent: string[][] = [];
  const lc = pidLifecycle([62]);
  const d = deps({
    db,
    settings: () => ({ ...ACCOUNT_POOL_DEFAULTS, projectAccounts: { shop: "primary" } }),
    exec: async (_c, cmd) => {
      if (cmd[0] === "tmux" && cmd[1] === "list-panes") return ok("main:0.0\t62\n");
      if (cmd[0] === "ps") return ok(lc.ps([62]));
      // The pane is (verified live) ALREADY on primary — the correct pinned account.
      if (cmd[0] === "cat" && cmd[1] === "/proc/64/environ") return ok(environOf("/home/dev/.claude-accounts/primary"));
      if (cmd[0] === "tmux" && cmd[1] === "send-keys") { sent.push(cmd as string[]); lc.onSendKeys(62, cmd[4] as string); return ok(); }
      return ok();
    },
  });
  const r = await switchAccount(d, ROW.id);
  expect(r.status).toBe("unchanged");
  if (r.status !== "unchanged") throw new Error("unreachable");
  expect(r.accountId).toBe("primary");   // NOT backup — the pin keeps the session on primary
  expect(sent.length).toBe(0);           // the pane was not touched at all, no /exit
});

test("all-exhausted branch: switches to another (still exhausted) account and carries exhausted:true", async () => {
  const db = openDb(":memory:");
  insertSession(db, ROW);
  insertAccount(db, { id: "primary", label: "primary@x.cz", disabled: 0, quarantined_at: null, added_at: 1 });
  insertAccount(db, { id: "backup", label: "backup@x.cz", disabled: 0, quarantined_at: null, added_at: 2 });
  upsertAccountUsage(db, usage("primary", 95, { five_hour_resets_at: NOW + 3 * HOUR }));
  upsertAccountUsage(db, usage("backup", 99, { five_hour_resets_at: NOW + HOUR }));   // frees up sooner
  insertLease(db, { account_id: "primary", client: "devbox", session_id: ROW.id, label: "shop/cms", created_at: NOW - HOUR, released_at: null });
  const lc = pidLifecycle([62]);
  const d = deps({
    db,
    exec: async (_c, cmd) => {
      if (cmd[0] === "tmux" && cmd[1] === "list-panes") return ok("main:0.0\t62\n");
      if (cmd[0] === "tmux" && cmd[1] === "send-keys") { lc.onSendKeys(62, cmd[4] as string); return ok(); }
      if (cmd[0] === "ps") return ok(lc.ps([62]));
      return ok();
    },
  });
  const r = await switchAccount(d, ROW.id);
  expect(r.status).toBe("switched");
  if (r.status !== "switched") throw new Error("unreachable");
  expect(r.accountId).toBe("backup");
  expect(r.exhausted).toBe(true);
});
