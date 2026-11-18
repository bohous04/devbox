import { useState } from "react";
import { CircleAlert, Loader2, Wrench } from "lucide-react";
import type { ThreadItem } from "../../../../shared/thread";
import { cn } from "@/lib/utils";
import { Chevron, Collapse } from "../primitives";

/** One line for a tool's input: its command, file or pattern when it has one, otherwise the JSON. */
function inputSummary(input: unknown): string {
  if (input !== null && typeof input === "object") {
    const o = input as Record<string, unknown>;
    for (const key of ["command", "file_path", "path", "pattern", "url", "description"]) {
      if (typeof o[key] === "string") return o[key] as string;
    }
  }
  return input === undefined ? "" : JSON.stringify(input);
}

/** A collapsible tool call: name and command on one line, the full input and output when opened. */
export function ToolCall({ item }: { item: ThreadItem }) {
  const [open, setOpen] = useState(false);
  const summary = inputSummary(item.input);
  const command = item.input !== null && typeof item.input === "object" && typeof (item.input as Record<string, unknown>).command === "string"
    ? (item.input as { command: string }).command : null;
  return (
    <div className={cn("rounded-lg border bg-card text-sm", item.isError && "border-red-600/40")}>
      <button type="button" className="flex min-h-10 w-full min-w-0 items-center gap-2 px-3 py-2 text-left" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Chevron open={open} />
        {item.status === "streaming"
          ? <Loader2 className="size-3.5 flex-none animate-spin text-muted-foreground" aria-label="running" />
          : item.isError
            ? <CircleAlert className="size-3.5 flex-none text-red-600 dark:text-red-400" aria-label="failed" />
            : <Wrench className="size-3.5 flex-none text-muted-foreground" aria-hidden="true" />}
        <span className="flex-none font-medium">{item.tool}</span>
        <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">{summary}</span>
      </button>
      <Collapse open={open}>
        <div className="space-y-2 border-t px-3 py-2">
          {command !== null
            ? <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-muted p-2 font-mono text-xs">{command}</pre>
            : item.input !== undefined && <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-2 font-mono text-xs">{JSON.stringify(item.input, null, 2)}</pre>}
          {item.output !== undefined
            ? <pre className={cn("max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-2 font-mono text-xs", item.isError && "text-red-700 dark:text-red-400")}>{item.output || "(no output)"}</pre>
            : <p className="text-xs text-muted-foreground">{item.status === "streaming" ? "running…" : "no output"}</p>}
        </div>
      </Collapse>
    </div>
  );
}
