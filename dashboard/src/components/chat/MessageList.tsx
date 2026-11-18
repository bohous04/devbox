import { Info } from "lucide-react";
import type { PendingRequest, ThreadItem } from "../../../../shared/thread";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { Markdown } from "./Markdown";
import { RequestForm } from "./RequestForm";
import { ToolCall } from "./ToolCall";

function RequestItem({ item, pending, onAnswer }: { item: ThreadItem; pending: PendingRequest | undefined; onAnswer: (requestId: string, answer: string) => Promise<void> }) {
  if (item.status === "open" && pending) return <RequestForm request={pending} onAnswer={(a) => onAnswer(pending.requestId, a)} />;
  return (
    <div className="rounded-lg border bg-card p-3 text-sm">
      <div className="text-muted-foreground"><Markdown text={item.text} /></div>
      <p className="mt-2 text-xs text-muted-foreground">
        {item.status === "answered" ? <>answered: <span className="text-foreground">{item.output ?? "—"}</span></>
          : item.status === "expired" ? "expired without an answer"
            : "waiting for an answer"}
      </p>
    </div>
  );
}

/** The thread: user and assistant messages, tool calls, requests (open ones as a form) and notices. */
export function MessageList({ items, pending, queued, onAnswer }: {
  items: ThreadItem[];
  pending: PendingRequest[];
  /** Runs still waiting behind the active one: their user message shows as queued. */
  queued: Set<string>;
  onAnswer: (requestId: string, answer: string) => Promise<void>;
}) {
  return (
    <ol className="flex flex-col gap-3" aria-label="Conversation">
      {items.map((it, i) => (
        <li key={`${it.seq}:${it.runId}:${it.itemId}:${i}`} className={cn("min-w-0", it.kind === "user" && "flex justify-end")}>
          {it.kind === "user" ? (
            <div className={cn("max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-primary px-3.5 py-2 text-sm text-primary-foreground", it.runId && queued.has(it.runId) && "opacity-70")}>
              {it.text}
              {it.runId && queued.has(it.runId) && <Badge variant="secondary" className="ml-2 align-middle">queued</Badge>}
            </div>
          ) : it.kind === "assistant" ? (
            <div className="text-sm leading-relaxed">
              <Markdown text={it.text} />
              {it.status === "streaming" && <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-muted-foreground/60 align-text-bottom" aria-label="writing" />}
            </div>
          ) : it.kind === "tool" ? (
            <ToolCall item={it} />
          ) : it.kind === "request" ? (
            <RequestItem item={it} pending={pending.find((p) => p.requestId === it.itemId)} onAnswer={onAnswer} />
          ) : (
            <p className="flex items-start gap-2 rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
              <Info className="mt-px size-3.5 flex-none" aria-hidden="true" />
              <span className="min-w-0 break-words">{it.text}</span>
            </p>
          )}
        </li>
      ))}
    </ol>
  );
}
