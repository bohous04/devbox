import type { LoggedEvent } from "./events";

export type BridgeCommand =
  | { kind: "startTurn"; text: string; attachments?: string[] }
  | { kind: "interrupt" }
  | { kind: "answer"; requestId: string; answer: string }
  // Nightly binary update: close and reopen the harness with resume; refused while a run is active.
  | { kind: "restartAgent" }
  | { kind: "stop" }
  // Held until `endWait` or expiry; `waitKind` because `kind` is the discriminator.
  | { kind: "declareWait"; reason: string; waitKind: "command" | "ci"; timeoutMinutes?: number }
  | { kind: "endWait" };

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
