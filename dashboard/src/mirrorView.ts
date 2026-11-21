import type { MirrorInfo, MirrorSendError } from "../../shared/mirror";
import { ApiError } from "./api";

/** A tmux session takes no images through its Chat view: they would have to reach the pane as files. */
export const MIRROR_IMAGES_OFF = "Images can't be sent to a terminal session; paste them in the terminal.";

export interface MirrorLock { code: MirrorSendError; message: string }

/** The lock a refused send (409 {error, message}) puts on the composer; null for any other failure, which the
 *  composer shows as its error. */
export function mirrorSendLock(e: unknown): MirrorLock | null {
  if (!(e instanceof ApiError) || e.status !== 409) return null;
  const b = (typeof e.body === "object" && e.body !== null ? e.body : {}) as { error?: unknown; message?: unknown };
  return typeof b.error === "string" && typeof b.message === "string" ? { code: b.error as MirrorSendError, message: b.message } : null;
}

/** The one line above the composer, both with an Open terminal button: the agent waiting for an answer only the
 *  terminal can give, or why a message cannot go in now (the last refused send wins over devd's own reason). */
export function mirrorNotice(info: MirrorInfo, sendLock: MirrorLock | null): { kind: "prompt" | "lock"; text: string } | null {
  if (info.terminalPrompt) return { kind: "prompt", text: info.terminalPrompt.text };
  const lock = sendLock ?? info.sendBlock;
  return lock ? { kind: "lock", text: lock.message } : null;
}

/** Why the composer field is off while empty: only devd's standing reason. A refused send leaves the text in the
 *  field, so it can be sent again once the terminal is sorted out. */
export function mirrorFieldOff(info: MirrorInfo): string | undefined {
  return info.sendBlock?.message;
}

/** The Chat view of an agent the mirror cannot read yet (Codex, Grok, Antigravity) or of an InstaBox session. */
export function mirrorUnsupported(info: MirrorInfo): string | null {
  if (info.state !== "unsupported") return null;
  return info.sendBlock?.message ?? (info.agent ? `Chat view isn't supported for ${info.agent} yet.` : "Chat view isn't supported for this session yet.");
}
