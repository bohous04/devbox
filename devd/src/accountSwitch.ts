// Switching a RUNNING session to another Anthropic account — the action behind `dev switch`
// (unlike accountAlerts.ts, which is only a warning). Restarts EVERY pane with a live
// claude in the container onto the new CLAUDE_CONFIG_DIR: DEVD_SESSION_ID is container-level
// env (see image/account-lease.sh), so main/main-2/main-3 in ONE container share the
// same sessionId — leaving any of them on the old account would mean the session keeps
// burning quota even though the dashboard claims it has been switched (review
// round 1, I2). The DB is written ONLY AFTER a verified restart of at least one pane:
// a restart in the middle of a live conversation must not make the DB claim something that did not happen (I4).

import type { Database } from "bun:sqlite";
import { currentAccount, lastSwitchAt } from "./accountLease";
import { chooseAccount } from "./accountPolicy";
import { toCandidates } from "./accounts";
import { specFor } from "./agents";
import {
  claudeProcsUnder, paneConfigDir, parsePanes, parseProcTree, restartPane,
  PANES_CMD, PS_TREE_CMD, type RestartDeps, type RestartOutcome,
} from "./ccUpkeep";
import type { AccountPoolSettings } from "./config";
import { getSession, insertLease, leaseHistory, releaseLeasesForSession } from "./db";

// The pane was ALREADY on the target profile, so it was not touched at all (no /exit) — it
// sits next to RestartOutcome, not inside it, because RestartOutcome describes the result
// of an ACTUAL restart attempt, and this state is recognized even BEFORE it. The key
// difference from the rest of the union: this is NOT a failure nor a hint of a problem — it
// is the whole point of this fix (leave a healthy pane with an in-progress turn alone).
export type PaneOutcome = RestartOutcome | "already-on-account";
export interface PaneSwitchResult { target: string; outcome: PaneOutcome }

export type SwitchAccountResult =
  | { status: "unknown-session" }
  | { status: "not-running" }
  // The Anthropic account pool only concerns profiles that really run on such an account
  // (agent-launch requests a lease only for them) — other sessions have nothing to switch and
  // `/exit` would only throw away their turn.
  | { status: "wrong-agent" }
  // Another switchAccount call on THE SAME session is running right now (see the lock
  // below) — a concurrent call on a different session never hits this status.
  | { status: "in-progress" }
  | { status: "no-account" }
  // Best account == the account on which ALL panes of this session ALREADY VERIFIABLY run
  // (the actual CLAUDE_CONFIG_DIR, not a guess from leases) — nothing is restarted.
  | { status: "unchanged"; accountId: string; label: string }
  | { status: "switched"; accountId: string; label: string; exhausted: boolean; panes: PaneSwitchResult[] }
  // A restart was attempted, but not a single pane could be verifiably switched —
  // the DB stays on the old account (see the comment at the top).
  | { status: "failed"; accountId: string; label: string; exhausted: boolean; panes: PaneSwitchResult[] };

export interface SwitchAccountDeps extends RestartDeps {
  db: Database;
  settings: () => AccountPoolSettings;
  now: () => number;
  // Shared across calls (see index.ts) — sessionIds currently going through
  // a switch. Two concurrent `dev switch` on THE SAME session could otherwise
  // send /exit into each other (the second hits a pane the first has just
  // returned to a live conversation, and throws away what the first has just restored).
  // A concurrent call on a DIFFERENT session (another container) does no harm.
  inFlight: Set<string>;
}

// Restarts only panes where claude really lives in their process tree — a pane
// with Codex alone (or a bare shell) is not touched at all. A pane that ALREADY runs on the
// target profile is not touched either — previously ALL panes with a live claude were
// restarted regardless of what profile they actually had, which needlessly threw away a
// healthy neighbour's in-progress turn (fix: read the actual
// CLAUDE_CONFIG_DIR via /proc/<pid>/environ, not a guess from leases — activeLeases is
// only a time-based estimate of occupancy, not evidence, see the comment at `unchanged` below,
// do not step into that twice).
//
// `cmdPrefix` EXPORTS CLAUDE_CONFIG_DIR into the pane's shell (`export …; cc --resume
// …`), NOT as a one-off prefix (`CLAUDE_CONFIG_DIR=… cc --resume …`) —
// agent-launch.sh exports the variable too and then does `exec zsh`, so the pane
// carries it for its whole lifetime. A one-off prefix would only apply to this
// one command: the next cc launch without a prefix — manual, or the nightly ccUpkeep
// (ccUpkeep.ts restartClaudePane without `cmdPrefix`) — would inherit the old value from the
// shell and silently return the pane to the ORIGINAL account, while the DB would keep claiming the new one
// (review round 4, I1).
//
// Strict restart proves the native exit ID, the shared transcript under the
// target profile, and the returned process's account and exact --resume ID.
// Missing identity never falls back to a fresh conversation.
async function restartPanes(deps: RestartDeps, container: string, configDir: string): Promise<PaneSwitchResult[]> {
  const list = await deps.exec(container, PANES_CMD, 15_000);
  const ps = await deps.exec(container, PS_TREE_CMD, 15_000);
  if (list.code !== 0 || list.timedOut || ps.code !== 0 || ps.timedOut) return [];   // unreachable container
  const procs = parseProcTree(ps.stdout);
  const out: PaneSwitchResult[] = [];
  for (const p of parsePanes(list.stdout)) {
    // The pane's nearest live claude (BFS from the pane root, see claudeProcsUnder) —
    // the one claude-launch.sh started, not a possible nested `claude` started by
    // the agent itself (bash tool). A pane without any is skipped.
    const claude = claudeProcsUnder(p.pid, procs)[0];
    if (!claude) continue;
    const currentDir = await paneConfigDir(deps, container, claude.pid);
    if (currentDir === configDir) {
      out.push({ target: p.target, outcome: "already-on-account" });
      continue;
    }
    if (currentDir === null) {
      out.push({ target: p.target, outcome: "unknown-session" });
      continue;
    }
    out.push({ target: p.target, outcome: await restartPane(deps, container, p, {
      cmdPrefix: `export CLAUDE_CONFIG_DIR=${configDir}; `,
      agentPid: claude.pid,
      exactClaudeAccount: { sourceConfigDir: currentDir, targetConfigDir: configDir },
    }) });
  }
  return out;
}

export async function switchAccount(deps: SwitchAccountDeps, sessionId: string): Promise<SwitchAccountResult> {
  const s = getSession(deps.db, sessionId);
  if (!s) return { status: "unknown-session" };
  if (s.status !== "running") return { status: "not-running" };
  // The Anthropic account pool only concerns profiles that really run on such an account.
  // We ask about a PROPERTY, not a name: `=== "codex"` would, after proxy profiles were added,
  // silently let claude-gpt/claude-grok through and it would take a lease it does not use.
  if (!specFor(s.agent).anthropicAccount) return { status: "wrong-agent" };
  if (deps.inFlight.has(sessionId)) return { status: "in-progress" };

  deps.inFlight.add(sessionId);
  try {
    const now = deps.now();
    const history = leaseHistory(deps.db, "devbox", sessionId);
    const current = currentAccount(history);
    // force: true — a manual `dev switch` is an explicit instruction, not a suggestion; cooldown
    // and hysteresis (which prevent ping-pong between almost equally loaded accounts) have
    // nothing to hold back here. `chooseAccount` may still return THE SAME account (still
    // the best, or the only option in the all-exhausted branch) — that is handled below as
    // "unchanged", but only AFTER verifying the panes' reality, not from `current` on
    // its own (see the comment below).
    const decision = chooseAccount({
      candidates: toCandidates(deps.db), current, lastSwitchAt: lastSwitchAt(history),
      now, force: true, project: s.project, repo: s.repo, settings: deps.settings(),
    });
    if (decision.accountId === null) return { status: "no-account" };

    // "unchanged" used to be derived from leases (active rows / `current`) and in
    // THAT case `restartPanes` was not called at all. RECONSIDERED: a lease is
    // only a RECORD of what devd THINKS happened, not a fact about reality — when
    // a previous switch restored only SOME of the panes (at least one succeeded, see the "failed"
    // branch below), the DB got ONE fresh lease row claiming "the whole session is
    // on the target account", even though the remaining pane stayed on the old one. That lease is fresh,
    // so any lease-based check (including the ORIGINAL one, which took into
    // account ALL active rows, review round 2 — main/main-2 with different accounts after
    // a split) would forever evaluate it as "unchanged" — without recreating the session it
    // could not be fixed (see accountSwitch.test.ts, "stale lease claims ... but
    // the pane actually runs on ..."). So the pane is ALWAYS verified via the actual
    // CLAUDE_CONFIG_DIR (paneConfigDir/restartPanes) — two extra execs on a manual
    // operator command hurt nobody, a silent lie about the pane's state does.
    //
    // A side benefit of dropping the shortcut: the error becomes SELF-HEALING. A stranded
    // pane (see the "failed" branch below) gets a new chance on EVERY subsequent
    // `dev switch`, because reality is read again — previously a lease written once
    // masked it forever, now at most until the next call.
    const configDir = `/home/dev/.claude-accounts/${decision.accountId}`;
    const panes = await restartPanes(deps, s.container, configDir);

    if (panes.length === 0) {
      // Unreachable container OR no pane with a live claude (both
      // indistinguishable, see restartPanes) — in neither case may the DB claim that the
      // switch was verified.
      return { status: "failed", accountId: decision.accountId, label: decision.label!, exhausted: decision.exhausted, panes };
    }
    // "already-on-account" counts as success just like "restarted" — in both
    // cases we READ the pane's actual CLAUDE_CONFIG_DIR and confirmed that it
    // is on the target account. Without this sentence a MIX (some already-on-account, some
    // restarted) could mistakenly fall into "failed" if no pane happened to carry
    // "restarted".
    if (!panes.some((p) => p.outcome === "restarted" || p.outcome === "already-on-account")) {
      return { status: "failed", accountId: decision.accountId, label: decision.label!, exhausted: decision.exhausted, panes };
    }

    // "unchanged" is ONLY the case where ALL panes were already VERIFIABLY on the target AND
    // the lease agreed — genuinely "nothing to do", the DB is not even touched.
    // If the lease agreed ONLY by chance (`current === decision.accountId`), but
    // the panes were not on the target, `allAlreadyCorrect` would be false and we would fall
    // into the branch below — so this condition distinguishes exactly the two states that
    // used to be confused:
    //   - all panes on the target AND the lease says so → unchanged, no write
    //   - all panes on the target, BUT the lease says something else → the DB needs to be
    //     fixed, even though nothing was restarted (see the "stale lease claims ...
    //     but the pane actually runs on ..." test) — without a write the DB would lie forever and
    //     the next `dev switch` would end the same way. Reported as "switched": for the
    //     operator it matters to see FROM THE RETURN VALUE that the record changed,
    //     even if it was only a fix, not a restart — `panes` with "already-on-account"
    //     attest that nothing was restarted along the way.
    const allAlreadyCorrect = panes.every((p) => p.outcome === "already-on-account");
    if (allAlreadyCorrect && current === decision.accountId) {
      return { status: "unchanged", accountId: decision.accountId, label: decision.label! };
    }

    releaseLeasesForSession(deps.db, sessionId, now);
    insertLease(deps.db, {
      account_id: decision.accountId, client: "devbox", session_id: sessionId,
      label: `${s.project}/${s.repo}`, created_at: now, released_at: null,
    });
    return { status: "switched", accountId: decision.accountId, label: decision.label!, exhausted: decision.exhausted, panes };
  } finally {
    deps.inFlight.delete(sessionId);
  }
}
