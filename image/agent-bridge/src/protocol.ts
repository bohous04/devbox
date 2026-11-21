import { isAcpAgent, type AcpAgentId } from "./acpAgents";
import type { LoggedEvent } from "./events";

/** Claude, Codex, or an ACP agent (ACP_AGENTS). */
export type HarnessId = "claude" | "codex" | AcpAgentId;

/** The harness, account and model a chat session switches to; `env` is applied to that harness process only. */
export interface SwitchTarget {
  harness: HarnessId;
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

/** The origins a `startTurn` may name; the others belong to runs the bridge starts itself. */
export type TurnOrigin = "user" | "critic";

export type BridgeCommand =
  // `attachments` (bridge 1.4.0+; older ones refuse a turn that has them): image paths under /inbox.
  // `origin` (bridge 1.3.0+): who sends the turn; absent = the user. devd's critic sends "critic".
  | { kind: "startTurn"; text: string; attachments?: string[]; origin?: TurnOrigin }
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
  // 1.7.0: reasoning effort from the next message on; null = the harness's default. Refused for a level the current
  // model does not offer; 1.8.0: before the model is known, taken from effort.state's `unchecked` and checked with
  // the next message.
  | { kind: "setEffort"; effort: string | null }
  | { kind: "switchTarget"; target: SwitchTarget; resume: string | null; handoff: HandoffDelivery | null };

export type ClientFrame =
  // `nonce` (1.6.0): a bound bridge answers it with a `bind` frame before anything else. Older bridges ignore it.
  // `session` (1.6.0): the session devd means; a bound bridge of another session drops the client unanswered.
  | { t: "hello"; afterSeq: number; nonce?: string; session?: string }
  | { t: "cmd"; id: string; cmd: BridgeCommand }
  // 1.5.0+ (S6-R21): devd's store holds every event up to `seq` durably; sent periodically on a live link. Older
  // bridges refuse an unknown frame type and close the link, so devd sends it only to a bridge that is new enough.
  | { t: "ack"; seq: number };
export type ServerFrame =
  | { t: "event"; e: LoggedEvent }
  | { t: "res"; id: string; ok: boolean; error?: string; result?: unknown }
  // `version` and `awaitingTarget` (the bridge holds no harness until devd sends switchTarget) are in every
  // handshake since 1.1.0; a bridge without them predates switching.
  | { t: "ready"; lastSeq: number; version?: string; awaitingTarget?: boolean }
  // 1.6.0: the answer to a hello's nonce, before the replay; `proof` = bridgeProof(secret, nonce, session).
  | { t: "bind"; session: string; proof: string };

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
  if (v.harness !== "claude" && v.harness !== "codex" && !isAcpAgent(v.harness)) {
    throw new ProtocolError('switchTarget.target.harness must be "claude", "codex" or an ACP agent id');
  }
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
      const cmd: BridgeCommand = { kind: "startTurn", text };
      if (v.attachments !== undefined) {
        if (!Array.isArray(v.attachments) || !v.attachments.every((a) => typeof a === "string")) {
          throw new ProtocolError("startTurn.attachments must be an array of strings");
        }
        cmd.attachments = v.attachments;
      }
      if (v.origin !== undefined) {
        if (v.origin !== "user" && v.origin !== "critic") throw new ProtocolError('startTurn.origin must be "user" or "critic"');
        cmd.origin = v.origin;
      }
      return cmd;
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
    case "setEffort":
      if (v.effort !== null && (typeof v.effort !== "string" || !/^[a-z]{1,16}$/.test(v.effort))) {
        throw new ProtocolError("setEffort.effort must be a lowercase level name or null");
      }
      return { kind: "setEffort", effort: v.effort };
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
    const hello: ClientFrame = { t: "hello", afterSeq: raw.afterSeq };
    if (raw.nonce !== undefined) {
      if (typeof raw.nonce !== "string" || !/^[0-9a-f]{32}$/.test(raw.nonce)) throw new ProtocolError("hello.nonce must be 32 lowercase hex characters");
      hello.nonce = raw.nonce;
    }
    if (raw.session !== undefined) {
      if (typeof raw.session !== "string" || raw.session === "" || raw.session.length > 128) throw new ProtocolError("hello.session must be a non-empty string of at most 128 characters");
      hello.session = raw.session;
    }
    return hello;
  }
  if (raw.t === "ack") {
    if (typeof raw.seq !== "number" || !Number.isInteger(raw.seq) || raw.seq < 0) {
      throw new ProtocolError("ack.seq must be a non-negative integer");
    }
    return { t: "ack", seq: raw.seq };
  }
  if (raw.t === "cmd") {
    return { t: "cmd", id: nonEmptyString(raw.id, "cmd.id"), cmd: parseCommand(raw.cmd) };
  }
  throw new ProtocolError(`unknown frame type: ${String(raw.t)}`);
}

export function encodeFrame(f: ServerFrame | ClientFrame): string {
  return JSON.stringify(f) + "\n";
}
