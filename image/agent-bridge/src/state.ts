import type { UsageBaseline } from "./claudeSession";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export interface BridgeState {
  harness: "claude" | "codex";
  nativeThreadId: string | null;
  account: string | null;
  model: string | null;
  activeRunId: string | null;
  queue: { runId: string; text: string; attachments: string[] }[];
  /** Epoch ms of automatic continuations. */
  continuations: number[];
  /** Claude's running usage totals at the last result; null for Codex or before the first result. */
  usageBaseline: UsageBaseline | null;
}

/** Null when the file is missing; throws on corrupt JSON so a damaged state is never silently reset. */
export function loadState(path: string): BridgeState | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as BridgeState;
}

export function saveState(path: string, s: BridgeState): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(s));
  renameSync(tmp, path);
}
