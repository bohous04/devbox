import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { UsageBaseline } from "./events";
import type { HandoffDelivery, HarnessId, SwitchTarget } from "./protocol";

/** A switch target as persisted: secret env values are dropped, their names kept in `droppedEnvKeys`. */
export type PersistedTarget = SwitchTarget & { droppedEnvKeys: string[] };

export interface BridgeState {
  harness: HarnessId;
  nativeThreadId: string | null;
  account: string | null;
  model: string | null;
  activeRunId: string | null;
  /** `harnessText` is what the harness was given when it differs from the user's text (a handoff preamble). */
  queue: { runId: string; text: string; attachments: string[]; harnessText?: string }[];
  /** Epoch ms of automatic continuations. */
  continuations: number[];
  /** Claude's running usage totals at the last result; null for Codex or before the first result. */
  usageBaseline: UsageBaseline | null;
  /** The target of the last switch (or setModel), with its resolved env; it overrides the launch env on restart.
   *  Null while the session runs as launched. */
  target: PersistedTarget | null;
  /** A switch's handoff not yet delivered with a user turn. */
  pendingHandoff: HandoffDelivery | null;
  /** The thread was opened new and no prompt has got through yet: an ACP agent still gets the devbox instructions
   *  (ruling S4-P3), also after a restart. */
  instructionsPending: boolean;
}

/** Null when the file is missing; throws on corrupt JSON so a damaged state is never silently reset. */
export function loadState(path: string): BridgeState | null {
  if (!existsSync(path)) return null;
  // Files written before switching existed have neither field: such a session never switched. Files from before
  // ACP agents have no instructionsPending: their threads were never ACP threads.
  return {
    target: null, pendingHandoff: null, instructionsPending: false,
    ...(JSON.parse(readFileSync(path, "utf8")) as Omit<BridgeState, "target" | "pendingHandoff" | "instructionsPending">),
  };
}

export function saveState(path: string, s: BridgeState): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(s));
  renameSync(tmp, path);
}
