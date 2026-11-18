import type { LoggedEvent } from "./events";

/** The harness, account and model a chat session switches to; `env` is applied to that harness process only. */
export interface SwitchTarget {
  harness: "claude" | "codex";
  account: string | null;
  model: string | null;
  env: Record<string, string>;
}

/** Context from before the switch, held until the next user turn: Codex injects `injectItems` when it can,
 *  otherwise the preamble is prepended to that one message. */
export interface HandoffDelivery {
  preamble: string | null;
  injectItems?: unknown[];
}

export type BridgeCommand =
  | { kind: "startTurn"; text: string; attachments?: string[] }
  | { kind: "interrupt" }
  | { kind: "answer"; requestId: string; answer: string }
  // Nightly binary update: close and reopen the harness with resume; refused while a run is active.
  | { kind: "restartAgent" }
  | { kind: "stop" }
  // Held until `endWait` or expiry; `waitKind` because `kind` is the discriminator.
  | { kind: "declareWait"; reason: string; waitKind: "command" | "ci"; timeoutMinutes?: number }
  | { kind: "endWait" }
  // Refused while a run is active or queued.
  | { kind: "setModel"; model: string }
  | { kind: "switchTarget"; target: SwitchTarget; resume: string | null; handoff: HandoffDelivery | null };

export type ClientFrame = { t: "hello"; afterSeq: number } | { t: "cmd"; id: string; cmd: BridgeCommand };
export type ServerFrame =
  | { t: "event"; e: LoggedEvent }
  | { t: "res"; id: string; ok: boolean; error?: string; result?: unknown }
  | { t: "ready"; lastSeq: number };

export class ProtocolError extends Error {}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function nonEmptyString(v: unknown, what: string): string {
  if (typeof v !== "string" || v === "") throw new ProtocolError(`${what} must be a non-empty string`);
  return v;
}

function nullableString(v: unknown, what: string): string | null {
  return v === null ? null : nonEmptyString(v, what);
}

function parseTarget(v: unknown): SwitchTarget {
  if (!isRecord(v)) throw new ProtocolError("switchTarget.target must be an object");
  if (v.harness !== "claude" && v.harness !== "codex") throw new ProtocolError('switchTarget.target.harness must be "claude" or "codex"');
  if (!isRecord(v.env) || !Object.values(v.env).every((x) => typeof x === "string")) {
    throw new ProtocolError("switchTarget.target.env must be an object of strings");
  }
  return {
    harness: v.harness,
    account: nullableString(v.account, "switchTarget.target.account"),
    model: nullableString(v.model, "switchTarget.target.model"),
    env: v.env as Record<string, string>,
  };
}

function parseHandoff(v: unknown): HandoffDelivery | null {
  if (v === null) return null;
  if (!isRecord(v)) throw new ProtocolError("switchTarget.handoff must be an object or null");
  if (v.preamble !== null && typeof v.preamble !== "string") throw new ProtocolError("switchTarget.handoff.preamble must be a string or null");
  if (v.injectItems === undefined) return { preamble: v.preamble };
  if (!Array.isArray(v.injectItems)) throw new ProtocolError("switchTarget.handoff.injectItems must be an array");
  return { preamble: v.preamble, injectItems: v.injectItems };
}

function parseCommand(v: unknown): BridgeCommand {
  if (!isRecord(v)) throw new ProtocolError("cmd must be an object");
  switch (v.kind) {
    case "startTurn": {
      const text = nonEmptyString(v.text, "startTurn.text");
      if (v.attachments === undefined) return { kind: "startTurn", text };
      if (!Array.isArray(v.attachments) || !v.attachments.every((a) => typeof a === "string")) {
        throw new ProtocolError("startTurn.attachments must be an array of strings");
      }
      return { kind: "startTurn", text, attachments: v.attachments };
    }
    case "interrupt":
    case "restartAgent":
    case "stop":
    case "endWait":
      return { kind: v.kind };
    case "answer": {
      const requestId = nonEmptyString(v.requestId, "answer.requestId");
      if (typeof v.answer !== "string") throw new ProtocolError("answer.answer must be a string");
      return { kind: "answer", requestId, answer: v.answer };
    }
    case "declareWait": {
      const reason = nonEmptyString(v.reason, "declareWait.reason");
      if (v.waitKind !== "command" && v.waitKind !== "ci") throw new ProtocolError('declareWait.waitKind must be "command" or "ci"');
      if (v.timeoutMinutes === undefined) return { kind: "declareWait", reason, waitKind: v.waitKind };
      if (typeof v.timeoutMinutes !== "number") throw new ProtocolError("declareWait.timeoutMinutes must be a number");
      return { kind: "declareWait", reason, waitKind: v.waitKind, timeoutMinutes: v.timeoutMinutes };
    }
    case "setModel":
      return { kind: "setModel", model: nonEmptyString(v.model, "setModel.model") };
    case "switchTarget": {
      if (!("resume" in v) || !("handoff" in v)) throw new ProtocolError("switchTarget needs resume and handoff (null for none)");
      return { kind: "switchTarget", target: parseTarget(v.target), resume: nullableString(v.resume, "switchTarget.resume"), handoff: parseHandoff(v.handoff) };
    }
    default:
      throw new ProtocolError(`unknown command kind: ${String(v.kind)}`);
  }
}

export function parseClientFrame(line: string): ClientFrame {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    throw new ProtocolError("frame is not valid JSON");
  }
  if (!isRecord(raw)) throw new ProtocolError("frame must be an object");
  if (raw.t === "hello") {
    if (typeof raw.afterSeq !== "number" || !Number.isInteger(raw.afterSeq) || raw.afterSeq < 0) {
      throw new ProtocolError("hello.afterSeq must be a non-negative integer");
    }
    return { t: "hello", afterSeq: raw.afterSeq };
  }
  if (raw.t === "cmd") {
    return { t: "cmd", id: nonEmptyString(raw.id, "cmd.id"), cmd: parseCommand(raw.cmd) };
  }
  throw new ProtocolError(`unknown frame type: ${String(raw.t)}`);
}

export function encodeFrame(f: ServerFrame | ClientFrame): string {
  return JSON.stringify(f) + "\n";
}
