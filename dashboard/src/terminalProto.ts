// Must exactly match the server-side ClientMsg in devd/src/terminal.ts.
export function terminalWsUrl(id: string, tmux?: string, loc: { protocol: string; host: string } = window.location): string {
  const proto = loc.protocol === "https:" ? "wss:" : "ws:";
  const q = tmux ? `?tmux=${encodeURIComponent(tmux)}` : "";
  return `${proto}//${loc.host}/api/sessions/${encodeURIComponent(id)}/terminal${q}`;
}

export const encodeInput = (d: string) => JSON.stringify({ t: "i", d });
export const encodeResize = (cols: number, rows: number) => JSON.stringify({ t: "r", cols, rows });
export const encodeUnlock = () => JSON.stringify({ t: "unlock" });

// History is in tmux (not in xterm.js): scroll = n wheel steps that devd sends to tmux
// even in read-only; bottom = exit copy-mode ("↓ Jump to end").
export type ScrollDir = "up" | "down";
export const MAX_SCROLL_STEPS = 20;
export const encodeScroll = (d: ScrollDir, n: number) => JSON.stringify({ t: "s", d, n: Math.min(Math.max(1, Math.trunc(n)), MAX_SCROLL_STEPS) });
export const encodeBottom = () => JSON.stringify({ t: "b" });

// deltaY (px) + `carry` (remainder from last time) → whole lines. Negative = wheel up = older
// history ("up"). The caller passes `rest` as the next `carry`, so a trackpad with small deltas
// scrolls too; reversing direction discards the remainder (like ScrollStepper on iOS), excess above
// clamp is discarded (no coasting after a hard flick).
export function wheelSteps(deltaY: number, lineHeight: number, carry = 0): { dir: ScrollDir | null; n: number; rest: number } {
  if (!(lineHeight > 0) || !Number.isFinite(deltaY)) return { dir: null, n: 0, rest: 0 };
  const acc = (carry !== 0 && deltaY !== 0 && (carry > 0) !== (deltaY > 0) ? 0 : carry) + deltaY;
  const lines = Math.trunc(acc / lineHeight);
  if (lines === 0) return { dir: null, n: 0, rest: acc };
  const n = Math.min(Math.abs(lines), MAX_SCROLL_STEPS);
  const rest = Math.abs(lines) > MAX_SCROLL_STEPS ? 0 : acc - lines * lineHeight;
  return { dir: lines < 0 ? "up" : "down", n, rest };
}

// Keys that the soft keyboard on a phone does not offer — the bar under the terminal.
export const KEY_SEQ: Record<string, string> = {
  Esc: "\x1b", Tab: "\t",
  Up: "\x1b[A", Down: "\x1b[B", Right: "\x1b[C", Left: "\x1b[D",
  "Ctrl-C": "\x03", "Ctrl-D": "\x04", Enter: "\r",
};
export const KEY_BAR: string[] = ["Esc", "Tab", "Ctrl-C", "Up", "Down", "Left", "Right", "Enter"];
