import type { RunRow, ThreadItem } from "../../shared/thread";

export interface HandoffInput {
  items: ThreadItem[];
  runs: RunRow[];
  /** Delta handoff: items of these runs are already in the target thread and are skipped. */
  coveredRunIds?: Set<string>;
  request: string;
  window: number;
  used: number;
  reserve: number;
}

export interface Handoff {
  /** null when nothing was selected (no history, or the budget left no room for any of it). */
  preamble: string | null;
  includedItemSeqs: number[];
  /** Candidate items that did not make it into the preamble. */
  omitted: number;
  budget: number;
}

const MAX_TOKENS = 16_000;
// Spec-mandated bound; the 16k-token cap binds first today.
const MAX_BYTES_AS_TOKENS = 64 * 1024;
const HEADER = "Context carried over from the previous conversation (selected messages, commands, errors, file changes and plans, oldest first):\n";
const WRAPPER = "\n\nUser message:\n";
const encoder = new TextEncoder();

// 1 token is charged per UTF-8 byte: a deliberate over-estimate that needs no tokenizer.
const cost = (s: string): number => encoder.encode(s).length;

export function handoffBudget(window: number, used: number, inputBytes: number, reserve: number): number {
  return Math.max(0, Math.min(MAX_TOKENS, MAX_BYTES_AS_TOKENS, window - used - inputBytes - reserve));
}

const COMMAND_TOOLS = new Set(["Bash", "command"]);
const FILE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit", "fileChange"]);
// update_plan: Codex's plan updates, as the bridge reports them (codexSession.ts).
const PLAN_TOOLS = new Set(["ExitPlanMode", "TodoWrite", "update_plan"]);

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function commandText(input: unknown): string | null {
  if (typeof input === "string") return input; // Codex: the command line itself
  const c = asRecord(input)?.command; // Claude Bash
  return typeof c === "string" ? c : null;
}

function filePaths(input: unknown): string[] | null {
  if (Array.isArray(input)) {
    // Codex fileChange: [{ path, kind, diff }]
    const paths = input.map((c) => asRecord(c)?.path);
    return paths.every((p): p is string => typeof p === "string") ? paths : null;
  }
  const r = asRecord(input);
  const p = r?.file_path ?? r?.notebook_path;
  return typeof p === "string" ? [p] : null;
}

function planText(tool: string, input: unknown): string | null {
  const r = asRecord(input);
  if (tool === "ExitPlanMode") return typeof r?.plan === "string" ? r.plan : null;
  if (tool === "update_plan") {
    if (!Array.isArray(r?.plan)) return null;
    const steps = (r.plan as unknown[]).map((s) => {
      const step = asRecord(s);
      return typeof step?.step === "string" ? `- [${String(step.status ?? "?")}] ${step.step}` : null;
    });
    if (!steps.every((l): l is string => l !== null)) return null;
    return [...(typeof r.explanation === "string" ? [r.explanation] : []), ...steps].join("\n");
  }
  if (!Array.isArray(r?.todos)) return null;
  const lines = (r.todos as unknown[]).map((t) => {
    const todo = asRecord(t);
    return typeof todo?.content === "string" ? `- [${String(todo.status ?? "?")}] ${todo.content}` : null;
  });
  return lines.every((l): l is string => l !== null) ? lines.join("\n") : null;
}

type Kind = "user" | "assistant" | "command" | "file" | "plan" | "error";

/** One candidate entry: the item rendered whole, or null when it is not part of the handoff. */
function render(it: ThreadItem, runs: Map<string, RunRow>): { kind: Kind; text: string } | null {
  if (it.kind === "user") {
    // The images stay in /inbox: the next agent can open them by path.
    const images = it.attachments === undefined ? "" : ` (images: ${it.attachments.join(", ")})`;
    return { kind: "user", text: `[user] ${it.text}${images}` };
  }
  if (it.kind === "assistant") return { kind: "assistant", text: `[assistant] ${it.text}` };
  if (it.kind === "notice") {
    // A failed run's error is stored as a notice carrying run.error; other notices are bookkeeping.
    const run = it.runId === null ? undefined : runs.get(it.runId);
    return run?.status === "failed" && run.error === it.text ? { kind: "error", text: `[error] ${it.text}` } : null;
  }
  if (it.kind !== "tool" || it.tool === undefined) return null;
  const tool = it.tool;
  if (COMMAND_TOOLS.has(tool)) {
    const cmd = commandText(it.input);
    const head = cmd === null ? "[command] (command text unavailable)" : `[command] ${cmd}`;
    return it.isError ? { kind: "error", text: `${head}\n[command failed] ${it.output ?? ""}` } : { kind: "command", text: head };
  }
  if (FILE_TOOLS.has(tool)) {
    const paths = filePaths(it.input);
    const head = paths === null ? "[file change] (paths unavailable)" : `[file change] ${paths.join(", ")}`;
    return it.isError ? { kind: "error", text: `${head}\n[file change failed] ${it.output ?? ""}` } : { kind: "file", text: head };
  }
  if (PLAN_TOOLS.has(tool)) {
    const plan = planText(tool, it.input);
    return { kind: "plan", text: `[plan] ${plan ?? "(plan text unavailable)"}` };
  }
  if (it.isError) return { kind: "error", text: `[error] ${tool}: ${it.output ?? ""}` };
  return null;
}

function omittedNote(n: number): string {
  return `(${n} earlier items omitted; read the full history with devbox_thread_read)`;
}

export function buildHandoff(i: HandoffInput): Handoff {
  const budget = handoffBudget(i.window, i.used, cost(i.request), i.reserve);
  const runs = new Map(i.runs.map((r) => [r.runId, r]));
  const candidates: { seq: number; kind: Kind; text: string }[] = [];
  for (const it of [...i.items].sort((a, b) => a.seq - b.seq)) {
    if (it.runId !== null && i.coveredRunIds?.has(it.runId)) continue;
    const r = render(it, runs);
    if (r !== null) candidates.push({ seq: it.seq, ...r });
  }

  // The request is never shortened; history is what gives way. Reserve room for the header and the
  // worst-case omitted note and the deliverInline wrapper so the final preamble cannot overshoot the budget.
  let left = budget - cost(WRAPPER) - cost(HEADER) - cost(omittedNote(candidates.length)) - 1;
  const chosen = new Set<number>();
  const take = (idx: number): void => {
    if (idx < 0 || chosen.has(idx)) return;
    const c = cost(candidates[idx].text) + 1;
    if (c > left) return; // too big: skipped whole, smaller ones may still fit
    chosen.add(idx);
    left -= c;
  };
  const last = (kind: Kind): number => candidates.findLastIndex((c) => c.kind === kind);
  take(last("user"));
  take(last("assistant"));
  take(candidates.findIndex((c) => c.kind === "user"));
  for (let k = candidates.length - 1; k >= 0; k--) take(k);

  if (chosen.size === 0) return { preamble: null, includedItemSeqs: [], omitted: candidates.length, budget };
  const picked = [...chosen].sort((a, b) => a - b).map((k) => candidates[k]);
  const omitted = candidates.length - picked.length;
  const body = picked.map((c) => c.text).join("\n");
  const preamble = `${HEADER}${body}${omitted > 0 ? `\n${omittedNote(omitted)}` : ""}`;
  return { preamble, includedItemSeqs: picked.map((c) => c.seq), omitted, budget };
}

export function deliverInline(h: Handoff, request: string): string {
  return h.preamble === null ? request : `${h.preamble}${WRAPPER}${request}`;
}
