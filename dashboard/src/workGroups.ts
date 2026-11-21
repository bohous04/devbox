import { isHousekeepingNotice, type RunRow, type ThreadItem } from "../../shared/thread";

// How the chat thread is laid out: a finished run's work (its tool calls and the prose between them) folds into one
// "Worked for …" row above the run's answer (its last assistant message). Nothing is dropped: opening the row shows
// every folded item, and each tool row opens to its full input and output.

export type WorkStatus = "completed" | "interrupted" | "failed";

export type ThreadRow =
  /** `answer`: the last assistant message of a finished run (gets the copy action). */
  | { type: "item"; item: ThreadItem; answer?: true }
  | { type: "work"; runId: string; status: WorkStatus; durationMs: number | null; items: ThreadItem[] };

const ENDED: ReadonlySet<string> = new Set<WorkStatus>(["completed", "interrupted", "failed"]);

/** Whether row `i` opens a turn: a prompt after another row, not right after a notice (which already sets it off).
 *  It gets a little more room above it (the Apple apps' WorkGroups.turnStarts). */
export function opensTurn(rows: ThreadRow[], i: number): boolean {
  const row = rows[i], prev = rows[i - 1];
  return i > 0 && row?.type === "item" && row.item.kind === "user" && !(prev?.type === "item" && prev.item.kind === "notice");
}

/** The thread's rows. A run folds only once it ended and only when it called a tool; a running run stays expanded
 *  (its last message may still turn out to be prose before the next tool). The fold sits where its first item was;
 *  user messages, requests and notices never fold. */
export function threadRows(all: ThreadItem[], runs: RunRow[]): ThreadRow[] {
  const items = all.filter((i) => !isHousekeepingNotice(i));
  const ended = new Map(runs.filter((r) => ENDED.has(r.status)).map((r) => [r.runId, r]));
  const answer = new Map<string, number>();
  const withTools = new Set<string>();
  items.forEach((it, i) => {
    if (it.runId === null) return;
    if (it.kind === "assistant") answer.set(it.runId, i);
    if (it.kind === "tool") withTools.add(it.runId);
  });
  const groups = new Map<string, Extract<ThreadRow, { type: "work" }>>();
  const rows: ThreadRow[] = [];
  items.forEach((item, i) => {
    const run = item.runId !== null && withTools.has(item.runId) ? ended.get(item.runId) : undefined;
    const folds = run !== undefined && (item.kind === "tool" || (item.kind === "assistant" && answer.get(run.runId) !== i));
    if (!folds) {
      const isAnswer = item.kind === "assistant" && item.runId !== null && ended.has(item.runId) && answer.get(item.runId) === i;
      rows.push(isAnswer ? { type: "item", item, answer: true } : { type: "item", item });
      return;
    }
    let g = groups.get(run.runId);
    if (!g) {
      const durationMs = run.startedAt !== null && run.endedAt !== null ? run.endedAt - run.startedAt : null;
      g = { type: "work", runId: run.runId, status: run.status as WorkStatus, durationMs, items: [] };
      groups.set(run.runId, g);
      rows.push(g);
    }
    g.items.push(item);
  });
  return rows;
}

/** "45s" · "2m 14s" · "1h 5m". */
export function shortDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** The fold's label: how long the run worked and how it ended. */
export function workLabel(status: WorkStatus, durationMs: number | null): string {
  const d = durationMs === null ? null : shortDuration(durationMs);
  if (status === "interrupted") return d ? `Stopped after ${d}` : "Stopped";
  if (status === "failed") return d ? `Failed after ${d}` : "Failed";
  return d ? `Worked for ${d}` : "Worked";
}

export type ToolKind = "command" | "read" | "edit" | "search" | "web" | "agent" | "other";

/** One line for a tool call: a past-tense verb and what it acted on (`code` = show the target as code). */
export interface ToolLabel { kind: ToolKind; verb: string; target: string; code: boolean }

const str = (o: Record<string, unknown>, k: string): string | null => (typeof o[k] === "string" && o[k] !== "" ? o[k] as string : null);
const base = (p: string) => p.replace(/\/+$/, "").split("/").pop() || p;
const host = (u: string) => { try { return new URL(u).host; } catch { return u; } };
const firstLine = (s: string) => s.split("\n")[0];

/** Claude Code's tool names, Codex's (`command`, `fileChange`) and ACP's tool kinds (`execute`, `read`, …; their
 *  input is `{ title, rawInput }`). An unknown tool keeps its own name and the old one-line input summary. */
export function toolLabel(tool: string | undefined, input: unknown): ToolLabel {
  const name = tool ?? "(unknown)";
  const o = input !== null && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const title = str(o, "title");
  switch (name) {
    case "Bash": case "BashOutput":
      return { kind: "command", verb: "Ran", target: firstLine(str(o, "command") ?? ""), code: true };
    case "command":
      return { kind: "command", verb: "Ran", target: firstLine(typeof input === "string" ? input : ""), code: true };
    case "execute":
      return { kind: "command", verb: "Ran", target: title ?? "a command", code: title !== null };
    case "Read":
      return { kind: "read", verb: "Read", target: base(str(o, "file_path") ?? ""), code: false };
    case "read":
      return { kind: "read", verb: "Read", target: title ?? "a file", code: false };
    case "Edit": case "MultiEdit": case "NotebookEdit":
      return { kind: "edit", verb: "Edited", target: base(str(o, "file_path") ?? str(o, "notebook_path") ?? ""), code: false };
    case "Write":
      return { kind: "edit", verb: "Wrote", target: base(str(o, "file_path") ?? ""), code: false };
    case "fileChange": {
      const paths = Array.isArray(input) ? input.flatMap((c) => (c && typeof c === "object" && typeof (c as { path?: unknown }).path === "string" ? [(c as { path: string }).path] : [])) : [];
      return { kind: "edit", verb: "Edited", target: paths.length === 1 ? base(paths[0]) : `${paths.length} files`, code: false };
    }
    case "edit": case "delete": case "move":
      return { kind: "edit", verb: name === "edit" ? "Edited" : name === "delete" ? "Deleted" : "Moved", target: title ?? "a file", code: false };
    case "Grep":
      return { kind: "search", verb: "Searched for", target: str(o, "pattern") ?? "", code: true };
    case "Glob":
      return { kind: "search", verb: "Listed", target: str(o, "pattern") ?? "", code: true };
    case "search":
      return { kind: "search", verb: "Searched", target: title ?? "", code: false };
    case "WebFetch": case "fetch":
      return { kind: "web", verb: "Fetched", target: str(o, "url") ? host(str(o, "url")!) : title ?? "", code: false };
    case "WebSearch":
      return { kind: "web", verb: "Searched the web for", target: str(o, "query") ?? "", code: false };
    case "Task": case "Agent":
      return { kind: "agent", verb: "Ran agent", target: str(o, "description") ?? "", code: false };
    case "TodoWrite":
      return { kind: "other", verb: "Updated the plan", target: "", code: false };
    default: {
      // MCP tools arrive as mcp__<server>__<tool>; show "server · tool".
      const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
      return { kind: "other", verb: mcp ? `${mcp[1]} · ${mcp[2]}` : name, target: title ?? inputSummary(input), code: title === null };
    }
  }
}

/** One line for an unknown tool's input: its command, file or pattern when it has one, otherwise the JSON. */
export function inputSummary(input: unknown): string {
  if (input !== null && typeof input === "object") {
    const o = input as Record<string, unknown>;
    for (const key of ["command", "file_path", "path", "pattern", "url", "description"]) {
      if (typeof o[key] === "string") return o[key] as string;
    }
  }
  return input === undefined || input === null ? "" : typeof input === "string" ? input : JSON.stringify(input);
}

/** What a fold holds, for its collapsed line: "3 commands · 2 edits" (failures are counted apart, in red). */
export function workSummary(items: ThreadItem[]): string {
  const tools = items.filter((i) => i.kind === "tool");
  const count = (k: ToolKind) => tools.filter((t) => toolLabel(t.tool, t.input).kind === k).length;
  const n = (c: number, one: string, many: string) => (c > 0 ? `${c} ${c === 1 ? one : many}` : null);
  const commands = count("command"), edits = count("edit"), reads = count("read"), searches = count("search");
  const rest = tools.length - commands - edits - reads - searches;
  return [
    n(commands, "command", "commands"), n(edits, "edit", "edits"), n(reads, "file read", "files read"),
    n(searches, "search", "searches"), n(rest, "other tool", "other tools"),
  ].filter((x) => x !== null).join(" · ");
}
