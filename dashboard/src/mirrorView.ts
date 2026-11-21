import type { MirrorInfo, MirrorSendError } from "../../shared/mirror";
import { ApiError } from "./api";

/** A tmux session takes no images through its Chat view: they would have to reach the pane as files. */
export const MIRROR_IMAGES_OFF = "Images can't be sent to a terminal session; paste them in the terminal.";

export type SessionRefusal = "session-ending" | "unknown-session" | "not-a-tmux-session";
export interface MirrorLock { code: MirrorSendError | SessionRefusal; message: string }

/** devd's session-level refusals (devd/src/mirrorApi.ts) come as bare codes: what they mean for the user. */
const SESSION_REFUSALS: Record<SessionRefusal, string> = {
  "session-ending": "This session is ending; nothing more can be sent to it.",
  "unknown-session": "devd no longer has this session.",
  "not-a-tmux-session": "This is no longer a terminal session; reload the page.",
};

/** The lock a refused send (404/409) puts on the composer; null for any other failure, which the composer shows as
 *  its error. */
export function mirrorSendLock(e: unknown): MirrorLock | null {
  if (!(e instanceof ApiError) || (e.status !== 409 && e.status !== 404)) return null;
  const b = (typeof e.body === "object" && e.body !== null ? e.body : {}) as { error?: unknown; message?: unknown };
  if (typeof b.error !== "string") return null;
  if (typeof b.message === "string") return { code: b.error as MirrorSendError, message: b.message };
  return Object.hasOwn(SESSION_REFUSALS, b.error) ? { code: b.error as SessionRefusal, message: SESSION_REFUSALS[b.error as SessionRefusal] } : null;
}

/** The mirror composer's onSend: a refusal becomes the lock and keeps the text (`false`); a sent message clears it. */
export async function sendToMirror(send: () => Promise<unknown>, setLock: (lock: MirrorLock | null) => void): Promise<void | false> {
  try {
    await send();
    setLock(null);
  } catch (e) {
    const lock = mirrorSendLock(e);
    if (!lock) throw e;
    setLock(lock);
    return false;
  }
}

/** The one line above the composer, both with an Open terminal button: the agent waiting for an answer only the
 *  terminal can give, or why a message cannot go in now (the last refused send wins over devd's own reason). */
export function mirrorNotice(info: MirrorInfo, sendLock: MirrorLock | null): { kind: "prompt" | "lock"; text: string; dismissible: boolean } | null {
  if (info.terminalPrompt) return { kind: "prompt", text: info.terminalPrompt.text, dismissible: false };
  if (sendLock) return { kind: "lock", text: sendLock.message, dismissible: true };
  return info.sendBlock ? { kind: "lock", text: info.sendBlock.message, dismissible: false } : null;
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
