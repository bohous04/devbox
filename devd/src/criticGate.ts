import type { Database } from "bun:sqlite";
import { insertCriticReview, logEvent, type SessionRow } from "./db";
import { isEmptyTurnDiff, renderTurnDiff, type TurnDiff } from "./criticDiff";
import {
  blockingFindings, blockReason, buildCriticPrompt, parseCriticOutput, type CriticCfg,
} from "./criticProvider";

export type Decision = { block: false } | { block: true; reason: string };

export interface CriticDeps {
  db: Database;
  /** HEAD SHA of the session workspace (the turn baseline), or null. */
  head: (s: SessionRow) => Promise<string | null>;
  /** Turn material diffed against the baseline. */
  diff: (s: SessionRow, baseline: string | null) => Promise<TurnDiff>;
  /** Runs the critic in the session container; returns raw stdout. */
  run: (s: SessionRow, prompt: string, cfg: CriticCfg) => Promise<string>;
  cfg: () => CriticCfg;
  now?: () => number;
  uuid?: () => string;
}

interface TurnState { id: string; baseline: Promise<string | null>; task: string; rounds: number }

/**
 * The gate before "done": on the `Stop` hook it decides whether the agent may finish.
 *
 * Turn state is only in memory (like AgentEventHub) — after a devd restart at worst
 * one turn goes unchecked, which is the right side to err on: the critic must never
 * block work because of its own failure (fail-open).
 */
export function createCriticGate(d: CriticDeps) {
  const turns = new Map<string, TurnState>();
  const now = () => d.now?.() ?? Date.now();
  const uuid = () => d.uuid?.() ?? crypto.randomUUID();

  function onPrompt(s: SessionRow, task: string): void {
    if (s.critic !== 1) { turns.delete(s.id); return; }
    turns.set(s.id, { id: uuid(), baseline: safeHead(s), task: task.slice(0, 4000), rounds: 0 });
  }

  function safeHead(s: SessionRow): Promise<string | null> {
    return d.head(s).catch(() => null);
  }

  async function onStop(s: SessionRow): Promise<Decision> {
    if (s.critic !== 1) return { block: false };
    const cfg = d.cfg();
    const turn = turns.get(s.id);
    // Without a known turn (devd restart mid-work) we have neither a baseline nor the task →
    // better to let it pass than to review blindly.
    if (!turn) return { block: false };
    if (turn.rounds >= cfg.rounds) return { block: false };

    const started = now();
    try {
      const diff = await d.diff(s, await turn.baseline);
      if (isEmptyTurnDiff(diff)) return { block: false };     // nothing changed, nothing to review
      const raw = await d.run(s, buildCriticPrompt(turn.task, renderTurnDiff(diff)), cfg);
      const verdict = parseCriticOutput(raw, cfg.provider);
      const blocking = blockingFindings(verdict);
      const at = now();
      insertCriticReview(d.db, {
        session_id: s.id, turn_id: turn.id, round: turn.rounds + 1,
        verdict: verdict.verdict, findings: JSON.stringify(verdict.findings),
        evidence: verdict.evidence ?? null, ms: at - started, at,
      });
      turn.rounds += 1;
      if (blocking.length === 0) {
        logEvent(d.db, s.id, "critic_pass", { round: turn.rounds, findings: verdict.findings.length });
        return { block: false };
      }
      if (turn.rounds >= cfg.rounds) {
        logEvent(d.db, s.id, "critic_giveup", { round: turn.rounds, findings: blocking.length });
        return { block: false };                              // round limit: let it pass with reservations
      }
      logEvent(d.db, s.id, "critic_block", { round: turn.rounds, findings: blocking.length });
      return { block: true, reason: blockReason(blocking) };
    } catch (e) {
      // FAIL-OPEN: whatever goes wrong (diff, exec, timeout, unreadable verdict) →
      // we let the work pass and only record it. The critic must not be a single point of failure.
      const at = now();
      const message = (e as Error).message;
      insertCriticReview(d.db, {
        session_id: s.id, turn_id: turn.id, round: turn.rounds + 1, verdict: "error",
        findings: "[]", evidence: message, ms: at - started, at,
      });
      logEvent(d.db, s.id, "critic_error", { message });
      return { block: false };
    }
  }

  return { onPrompt, onStop };
}
