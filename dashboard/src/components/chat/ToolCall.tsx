import { useState } from "react";
import { Bot, Check, CircleAlert, FilePen, FileText, Globe, Loader2, Search, SquareTerminal, Wrench } from "lucide-react";
import type { ThreadItem } from "../../../../shared/thread";
import { cn } from "@/lib/utils";
import { toolLabel, type ToolKind } from "../../workGroups";
import { Chevron, Collapse } from "../primitives";

const ICON: Record<ToolKind, typeof Wrench> = {
  command: SquareTerminal, read: FileText, edit: FilePen, search: Search, web: Globe, agent: Bot, other: Wrench,
};

/** A tool call as one quiet line ("Ran `bun test`", "Edited queue.ts"); it opens to the full input and output. */
export function ToolCall({ item }: { item: ThreadItem }) {
  const [open, setOpen] = useState(false);
  const label = toolLabel(item.tool, item.input);
  const Icon = ICON[label.kind];
  const command = item.input !== null && typeof item.input === "object" && typeof (item.input as Record<string, unknown>).command === "string"
    ? (item.input as { command: string }).command
    : typeof item.input === "string" ? item.input : null;
  return (
    <div className="text-sm">
      {/* 36px on phone, not the global 44px: a fold's rows stack tightly, and 36px still clears the 24px target minimum. */}
      <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)}
        className="group -mx-1.5 flex min-h-8 w-[calc(100%+0.75rem)] max-sm:min-h-9! min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground">
        {item.status === "streaming"
          ? <Loader2 role="img" className="size-3.5 flex-none animate-spin" aria-label="running" />
          : item.isError
            ? <CircleAlert role="img" className="size-3.5 flex-none text-red-600 dark:text-red-400" aria-label="failed" />
            : <Icon className="size-3.5 flex-none opacity-80" aria-hidden="true" />}
        <span className="flex-none">{label.verb}</span>
        {/* The full command or input on hover; opening the row shows it wrapped, with the output. */}
        {label.target && (
          label.code
            ? <code title={command ?? label.target} className="min-w-0 truncate rounded-[5px] bg-muted/70 px-1.5 py-px font-mono text-[0.78rem] text-foreground/85 max-sm:whitespace-normal max-sm:break-all">{label.target}</code>
            : <span title={label.target} className="min-w-0 truncate text-foreground/85">{label.target}</span>
        )}
        {/* Pass or fail from the tool's own result flag; the stream carries no exit code or duration. */}
        <span className="ml-auto flex flex-none items-center gap-1.5">
          {item.isError
            ? <span className="text-xs text-red-600 dark:text-red-400">failed</span>
            : item.status === "done" && item.output !== undefined && <Check role="img" aria-label="succeeded" className="size-3.5 text-emerald-600/80 dark:text-emerald-400/80" />}
          {/* Shown on hover, or always where there is no hover (touch), so a cut-off command visibly opens. */}
          <span className="opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 group-aria-expanded:opacity-100 [@media(hover:none)]:opacity-100"><Chevron open={open} /></span>
        </span>
      </button>
      <Collapse open={open}>
        <div className="mb-2 ml-5 mt-1 space-y-2">
          <p className="text-xs text-muted-foreground">{item.tool ?? "(unknown)"}</p>
          {command !== null
            ? <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-lg border border-border/60 bg-muted/50 px-3 py-2 font-mono text-xs leading-relaxed">{command}</pre>
            : item.input !== undefined && <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border/60 bg-muted/50 px-3 py-2 font-mono text-xs leading-relaxed">{JSON.stringify(item.input, null, 2)}</pre>}
          {item.output !== undefined
            ? <pre className={cn("max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border/60 bg-muted/30 px-3 py-2 font-mono text-xs leading-relaxed text-muted-foreground", item.isError && "border-red-600/30 text-red-700 dark:text-red-400")}>{item.output || "(no output)"}</pre>
            : <p className="text-xs text-muted-foreground">{item.status === "streaming" ? "running…" : "no output"}</p>}
        </div>
      </Collapse>
    </div>
  );
}
