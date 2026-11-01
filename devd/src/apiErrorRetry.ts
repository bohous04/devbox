// Auto-"continue" after API 429: when a cc session dies on "API Error: Request rejected
// (429) · Provider returned error" (typically a transient 429 from cliproxy, see AI subs),
// devd sends "continue" into the panel after 5 minutes of quiet — and repeats it every ~5 min
// until the provider lets it through. Detection is purely CONTENT-based (capture-pane): pane_current_command
// is useless, the agent runs under the wrapping bash from agent-launch (measured live — all
// panels report "bash").
//
// The UI shape is measured from live capture-pane outputs (2026-08-23), not guessed:
//  - after a 429 abort cc STILL prints the turn summary ("✻ Baked for 10m 28s") and possibly
//    a recap — a rule "the error is the last line" would never trigger;
//  - cc input area = horizontal ─── lines with ❯ (the top one may carry the session title);
//    Grok Build (a cc fork) draws a ╭─╮ │ ❯ │ ╰─╯ box — the parser accepts both;
//  - an unsubmitted draft may be sitting in the input → Enter would send it,
//    so it is sent ONLY into an empty input.

export const CONTINUE_DELAY_MS = 5 * 60_000;

const API_ERROR_RE = /API Error.*\(429\)/;
// Turn summary after a finished/died turn: "✻ Baked for 10m 28s", "✻ Worked for 9m7s".
const TURN_SUMMARY_RE = /^\s*\S+\s+\S+ for \d/;
// The recap ends right before the input area, its wrapped lines cannot be recognized by shape →
// from the recap line onward everything is allowed.
const RECAP_RE = /^\s*\S+\s+recap:/;

const ruleLike = (line: string) => /─{10,}/.test(line);

// Empty input: "❯" (cc) or "│ ❯ … │" (grok box) without any text.
function emptyPrompt(line: string): boolean {
  const inner = line.replace(/^\s*│?\s*/, "").replace(/[\s│]*$/, "");
  return inner === "❯";
}

// Is the panel CURRENTLY stuck on 429? I.e.: above the input area there is an error line and between it
// and the input nothing but turn summary/recap came; the input is empty; nothing is running.
export function detectStuck429(captured: string): boolean {
  const lines = captured.split("\n");

  // Input area = the last TWO line rows, with the ❯ prompt between them.
  const rules: number[] = [];
  for (let i = 0; i < lines.length; i++) if (ruleLike(lines[i])) rules.push(i);
  if (rules.length < 2) return false;
  const rb = rules[rules.length - 1];
  const rt = rules[rules.length - 2];
  if (rb - rt < 2) return false;

  const between = lines.slice(rt + 1, rb).filter((l) => l.trim() !== "");
  if (between.length !== 1 || !emptyPrompt(between[0])) return false;

  // The last error line in the transcript above the input.
  let errIdx = -1;
  for (let i = rt - 1; i >= 0; i--) {
    if (API_ERROR_RE.test(lines[i])) { errIdx = i; break; }
  }
  if (errIdx < 0) return false;

  // Running turn (spinner "… (esc to interrupt)") → do not intervene.
  for (let i = errIdx + 1; i < rt; i++) {
    if (lines[i].includes("esc to interrupt")) return false;
  }

  // Wrap continuation of the error line: contiguous non-empty lines right after it.
  let i = errIdx + 1;
  while (i < rt && lines[i].trim() !== "") i++;

  for (; i < rt; i++) {
    const l = lines[i];
    if (l.trim() === "") continue;
    if (RECAP_RE.test(l)) return true;         // recap = the last thing before the input
    if (TURN_SUMMARY_RE.test(l)) continue;
    return false;                              // anything else = things happened after the error
  }
  return true;
}

export type PaneCheck = { key: string; captured: string };

// Countdown per panel: 5 minutes WITHOUT A CHANGE of content with the stuck error → fire, and the state
// is dropped (the next cycle starts over → the natural "every ~5 min while it lasts").
// Any content change (typing, spinner, new output) resets the countdown.
export class ApiErrorRetry {
  private state = new Map<string, { firstSeen: number; captured: string }>();
  constructor(private delayMs: number = CONTINUE_DELAY_MS) {}

  tick(panes: PaneCheck[], now: number): string[] {
    const fired: string[] = [];
    const seen = new Set<string>();
    for (const p of panes) {
      seen.add(p.key);
      if (!detectStuck429(p.captured)) {
        this.state.delete(p.key);
        continue;
      }
      const st = this.state.get(p.key);
      if (!st || st.captured !== p.captured) {
        this.state.set(p.key, { firstSeen: now, captured: p.captured });
        continue;
      }
      if (now - st.firstSeen >= this.delayMs) {
        this.state.delete(p.key);
        fired.push(p.key);
      }
    }
    // Vanished panels (session ended / container unreachable) → drop the state,
    // so the map does not grow and the countdown does not survive a measurement outage.
    for (const k of [...this.state.keys()]) if (!seen.has(k)) this.state.delete(k);
    return fired;
  }
}

// One exec per container: lists all tmux panels and their visible content,
// separated by ===PANE headers.
export const PANE_PROBE_CMD =
  `tmux list-panes -a -F '#{session_name} #{pane_id}' 2>/dev/null | while read -r s i; do ` +
  `printf '===PANE %s %s\\n' "$s" "$i"; tmux capture-pane -p -t "$i" 2>/dev/null; done`;

export function parsePanes(out: string): { session: string; pane: string; captured: string }[] {
  const panes: { session: string; pane: string; captured: string }[] = [];
  let current: { session: string; pane: string; lines: string[] } | null = null;
  for (const line of out.split("\n")) {
    const m = line.match(/^===PANE (\S+) (\S+)$/);
    if (m) {
      if (current) panes.push({ session: current.session, pane: current.pane, captured: current.lines.join("\n") });
      current = { session: m[1], pane: m[2], lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) panes.push({ session: current.session, pane: current.pane, captured: current.lines.join("\n") });
  return panes;
}

export type Sweep429Deps = {
  containers: () => string[];
  exec: (container: string, cmd: string[]) => Promise<{ stdout: string }>;
  retry: ApiErrorRetry;
};

export type ContinueSent = { container: string; session: string; pane: string };

export async function sweep429(deps: Sweep429Deps, now: number): Promise<ContinueSent[]> {
  const all: PaneCheck[] = [];
  const meta = new Map<string, ContinueSent>();
  for (const container of deps.containers()) {
    let out = "";
    try {
      out = (await deps.exec(container, ["sh", "-c", PANE_PROBE_CMD])).stdout;
    } catch {
      continue;   // unreachable container → the tick cleans up its state by itself (prune)
    }
    for (const p of parsePanes(out)) {
      const key = `${container}/${p.pane}`;
      meta.set(key, { container, session: p.session, pane: p.pane });
      all.push({ key, captured: p.captured });
    }
  }
  const sent: ContinueSent[] = [];
  for (const key of deps.retry.tick(all, now)) {
    const m = meta.get(key);
    if (!m) continue;
    try {
      // -l = literal (no interpretation of key names), Enter separately as a key.
      await deps.exec(m.container, ["tmux", "send-keys", "-t", m.pane, "-l", "continue"]);
      await deps.exec(m.container, ["tmux", "send-keys", "-t", m.pane, "Enter"]);
      sent.push(m);
    } catch (e) {
      console.error(`429 auto-continue: send to ${m.container}/${m.pane} failed:`, e);
    }
  }
  return sent;
}
