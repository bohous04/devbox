import { existsSync, readFileSync } from "node:fs";
import { replaceFileDurably, writeAll } from "./durable";
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
  /** `harnessText` is what the harness was given when it differs from the user's text (a handoff preamble);
   *  `origin` is set for a critic follow-up only (absent = the user's message). */
  queue: { runId: string; text: string; attachments: string[]; harnessText?: string; origin?: "critic" }[];
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
  /** (bridge 1.5.0+) The event log may drop what is at or below this seq: an ack (a hello's afterSeq) that was at
   *  least ACK_TRIM_DELAY_MS old when a later hello came that was not below it. 0 = nothing is dropped. */
  trimSeq: number;
  /** (bridge 1.5.0+) The latest ack not yet old enough to trim to, with when it came (epoch ms). */
  ackCandidate: { seq: number; at: number } | null;
  /** (bridge 1.5.0+) No harness opens until devd sends switchTarget: set when a lost state.json was rebuilt from a
   *  thread of another harness than the launch one (its target is devd's to say), and (1.10.1+) after a failed
   *  resume, until devd's fresh target with the full handoff arrives. */
  awaitingTarget: boolean;
  /** (bridge 1.7.0) The user's reasoning effort, kept across restarts and switches; null = the harness's default.
   *  Files from before 1.7.0 have none. */
  effort: string | null;
  /** (bridge 1.11.0) devd's switchId of the switch to `target` whose target.applied is not logged yet: saved with the
   *  target, so a bridge restarted mid-switch still reports it once the target is open. */
  appliedSwitchId: string | null;
}

/** state.json exists but cannot be used (empty, not JSON, wrong shape): serve recovers from the event log. */
export class StateCorruptError extends Error {}

type Check = (v: unknown, at: string) => void;

const fail = (at: string, what: string): never => {
  throw new StateCorruptError(`${at}: ${what}`);
};
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str: Check = (v, at) => void (typeof v !== "string" && fail(at, "not a string"));
const nullable = (c: Check): Check => (v, at) => void (v !== null && c(v, at));
const num: Check = (v, at) => void (typeof v !== "number" && fail(at, "not a number"));
const bool: Check = (v, at) => void (typeof v !== "boolean" && fail(at, "not a boolean"));
const arr = (c: Check): Check => (v, at) => {
  if (!Array.isArray(v)) fail(at, "not an array");
  (v as unknown[]).forEach((x, i) => c(x, `${at}[${i}]`));
};
const obj = (fields: Record<string, Check>, optional: Record<string, Check> = {}): Check => (v, at) => {
  if (!isObj(v)) fail(at, "not an object");
  const o = v as Record<string, unknown>;
  for (const [k, c] of Object.entries(fields)) c(o[k], `${at}.${k}`);
  for (const [k, c] of Object.entries(optional)) if (o[k] !== undefined) c(o[k], `${at}.${k}`);
};
const strRecord: Check = (v, at) => {
  if (!isObj(v)) fail(at, "not an object");
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) str(x, `${at}.${k}`);
};
const seq: Check = (v, at) => void (!(Number.isSafeInteger(v) && (v as number) >= 0) && fail(at, "not a non-negative integer"));

const usage = obj({ input: num, output: num, cacheCreation: num, cacheRead: num });
const checkState = obj(
  {
    harness: str,
    nativeThreadId: nullable(str),
    account: nullable(str),
    model: nullable(str),
    activeRunId: nullable(str),
    queue: arr(obj({ runId: str, text: str, attachments: arr(str) }, { harnessText: str, origin: (v, at) => void (v !== "critic" && fail(at, "not \"critic\"")) })),
    continuations: arr(num),
    usageBaseline: nullable(obj({ usage, costUsd: num })),
  },
  {
    // Absent in files from before switching, ACP agents or log trimming: see loadState.
    target: nullable(obj({ harness: str, account: nullable(str), model: nullable(str), env: strRecord, droppedEnvKeys: arr(str) })),
    pendingHandoff: nullable(obj({ preamble: nullable(str) }, { injectItems: arr(() => {}) })),
    instructionsPending: bool,
    trimSeq: seq,
    ackCandidate: nullable(obj({ seq, at: num })),
    awaitingTarget: bool,
    effort: nullable(str),
    appliedSwitchId: nullable(str),
  },
);

/** Null when the file is missing; StateCorruptError when it is empty, not JSON or not a state (never silently
 *  reset: serve recovers from the event log and says so). Other read errors are thrown as they are. */
export function loadState(path: string): BridgeState | null {
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8");
  if (text.trim() === "") throw new StateCorruptError("the file is empty");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new StateCorruptError(`not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  checkState(raw, "state");
  // Files written before switching existed have neither target nor pendingHandoff: such a session never switched.
  // Files from before ACP agents have no instructionsPending: their threads were never ACP threads. Files from
  // before 1.5.0 have no trimSeq or ackCandidate (nothing was trimmed) and never awaited a target across a restart.
  return {
    target: null, pendingHandoff: null, instructionsPending: false, trimSeq: 0, ackCandidate: null, awaitingTarget: false, effort: null,
    appliedSwitchId: null,
    ...(raw as Partial<BridgeState>),
  } as BridgeState;
}

/** Durable: a crash or power loss leaves the previous or the new state, never an empty file. */
export function saveState(path: string, s: BridgeState): void {
  replaceFileDurably(path, (fd) => writeAll(fd, JSON.stringify(s)));
}
