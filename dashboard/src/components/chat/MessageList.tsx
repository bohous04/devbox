import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check, ChevronRight, CircleAlert, Copy, ShieldCheck, TriangleAlert } from "lucide-react";
import type { PendingRequest, RunRow, ThreadItem } from "../../../../shared/thread";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { changesAnchor } from "../../changesView";
import { attachmentUrl } from "../../imageView";
import { endedAttachmentUrl } from "../../endedView";
import { opensTurn, threadRows, workLabel, workSummary, type ThreadRow } from "../../workGroups";
import { Collapse } from "../primitives";
import { Markdown } from "./Markdown";
import { RequestForm } from "./RequestForm";
import { ChangesCard } from "./ChangesCard";
import { ToolCall } from "./ToolCall";

function RequestItem({ item, pending, onAnswer }: { item: ThreadItem; pending: PendingRequest | undefined; onAnswer: (requestId: string, answer: string) => Promise<void> }) {
  if (item.status === "open" && pending) return <RequestForm request={pending} onAnswer={(a) => onAnswer(pending.requestId, a)} />;
  return (
    <div className="rounded-xl border bg-card/40 px-4 py-3 text-sm">
      <div className="text-muted-foreground"><Markdown text={item.text} /></div>
      <p className="mt-2 text-xs text-muted-foreground">
        {item.status === "answered" ? <>answered: <span className="text-foreground">{item.output ?? "—"}</span></>
          : item.status === "expired" ? "expired without an answer"
            : "waiting for an answer"}
      </p>
    </div>
  );
}

/** An ended session's transcript (endedView.ts) shows its images from the archive and has no changes card. */
const Transcript = createContext<string | null>(null);

function Images({ sessionId, paths }: { sessionId: string; paths: string[] }) {
  const endedId = useContext(Transcript);
  const url = (p: string) => (endedId !== null ? endedAttachmentUrl(endedId, p) : attachmentUrl(sessionId, p));
  return (
    <div className="mb-2 flex flex-wrap gap-1.5">
      {paths.map((p) => (
        <a key={p} href={url(p)} target="_blank" rel="noreferrer">
          <img src={url(p)} alt="Attached image" loading="lazy" className="max-h-40 max-w-full rounded-lg object-cover" />
        </a>
      ))}
    </div>
  );
}

/** The owner's message: a quiet bubble on the right of the reading column. */
function UserMessage({ sessionId, item, queued }: { sessionId: string; item: ThreadItem; queued: boolean }) {
  return (
    <div className="flex justify-end">
      <div className={cn("max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md border border-border/70 bg-muted/70 px-3.5 py-2 text-[0.9375rem] leading-normal text-foreground sm:max-w-[80%] sm:px-4 sm:py-2.5 sm:leading-relaxed", queued && "opacity-60")}>
        {item.attachments && <Images sessionId={sessionId} paths={item.attachments} />}
        <ClampedText text={item.text} />
        {queued && <Badge variant="secondary" className="ml-2 align-middle">queued</Badge>}
      </div>
    </div>
  );
}

/** A long prompt folds to six lines so it doesn't outweigh the answer; "Show more" opens it in place. The toggle
 *  appears only when the text really overflows (measured, and again when the column's width changes). */
function ClampedText({ text }: { text: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || open) return;
    const measure = () => setOverflows(el.scrollHeight > el.clientHeight + 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text, open]);
  return (
    <>
      <span ref={ref} className={cn("block", !open && "line-clamp-6")}>{text}</span>
      {(overflows || open) && (
        <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)}
          className="mt-1 min-h-0! text-sm font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
          {open ? "Show less" : "Show more"}
        </button>
      )}
    </>
  );
}

/** A follow-up devd's critic sent as a user message: a reviewer's note in the column, not the owner's bubble. */
function CriticNote({ sessionId, item, queued }: { sessionId: string; item: ThreadItem; queued: boolean }) {
  return (
    <aside aria-label="Critic review" className={cn("rounded-xl border border-amber-600/20 bg-amber-500/[0.05] px-4 py-3 text-sm dark:border-amber-400/15 dark:bg-amber-400/[0.04]", queued && "opacity-60")}>
      <p className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-amber-800 dark:text-amber-300">
        <ShieldCheck className="size-3.5" aria-hidden="true" />
        From the critic
        {queued && <Badge variant="secondary" className="ml-1">queued</Badge>}
      </p>
      {item.attachments && <Images sessionId={sessionId} paths={item.attachments} />}
      <div className="text-muted-foreground"><Markdown text={item.text} /></div>
    </aside>
  );
}

function Prose({ item, quiet }: { item: ThreadItem; quiet?: boolean }) {
  return (
    <div className={cn(quiet ? "py-1 text-[0.8125rem] leading-normal text-muted-foreground/85" : "text-[0.9375rem] leading-[1.55] text-foreground/90")}>
      <Markdown text={item.text} />
      {item.status === "streaming" && <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse rounded-sm bg-muted-foreground/60 align-text-bottom" role="img" aria-label="writing" />}
    </div>
  );
}

type WorkRow = Extract<ThreadRow, { type: "work" }>;

/** The fold's text: "Worked for 28s · 3 commands", failures in red. */
function WorkText({ row }: { row: WorkRow }) {
  const summary = workSummary(row.items);
  const failed = row.items.filter((i) => i.kind === "tool" && i.isError).length;
  return (
    <>
      <span className="flex-none">{workLabel(row.status, row.durationMs)}</span>
      {(summary || failed > 0) && (
        <span className="min-w-0 truncate">
          {/* Margins, not spaces: a flex item drops its leading space. */}
          <span aria-hidden="true" className="mr-1.5 opacity-50">·</span>
          {summary}
          {failed > 0 && <span className="text-red-600 dark:text-red-400">{summary && " · "}{failed} failed</span>}
        </span>
      )}
    </>
  );
}

/** Copies a finished run's answer (its markdown source). A failed copy says so; nothing is retried. */
function CopyAnswer({ text }: { text: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  // One pending reset at a time (a second click restarts it), none left running after unmount.
  const reset = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(reset.current), []);
  const copy = () => {
    clearTimeout(reset.current);
    navigator.clipboard.writeText(text).then(() => setState("copied"), () => setState("failed"));
    reset.current = setTimeout(() => setState("idle"), 1800);
  };
  return (
    // Wide screens: no height at all, in the column's right margin by the answer's last line, shown on hover or focus
    // (always where there is no hover). Narrower screens have no margin, so it sits at the start under the answer, away
    // from the next (right-aligned) user bubble, and hangs into the gap before it (adds ~12px, not a full line).
    <div className="-mb-3 -ml-1.5 flex h-7 items-center gap-1 text-xs text-muted-foreground lg:absolute lg:bottom-0 lg:left-full lg:mb-0 lg:ml-2">
      <button type="button" onClick={copy} aria-label={state === "copied" ? "Copied" : "Copy answer"} title="Copy answer"
        className="grid size-7 min-h-0! place-items-center rounded-md text-muted-foreground/70 transition-[opacity,color,background-color] hover:bg-muted/60 hover:text-foreground focus-visible:opacity-100 lg:opacity-0 lg:group-hover/answer:opacity-100 lg:group-focus-within/answer:opacity-100 [@media(hover:none)]:opacity-100">
        {state === "copied" ? <Check className="size-3.5" aria-hidden="true" /> : <Copy className="size-3.5" aria-hidden="true" />}
      </button>
      {state !== "idle" && <span role="status" className={cn("whitespace-nowrap", state === "failed" && "text-destructive")}>{state === "copied" ? "Copied" : "Could not copy"}</span>}
    </div>
  );
}

/** A finished run's work, folded to one line: "Worked for 2m 14s · 3 commands". Open, it lists every tool call
 *  and the prose between them. */
function WorkGroup({ row }: { row: WorkRow }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b border-border/70 pb-2">
      {/* Same shape open or closed: text and chevron on the prose's left edge, no fill; hover only brightens it. */}
      <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)}
        className="group flex min-h-8 max-w-full min-w-0 items-center gap-1.5 py-1 text-left text-sm text-muted-foreground transition-colors hover:text-foreground aria-expanded:text-foreground">
        <WorkText row={row} />
        <ChevronRight className={cn("size-4 flex-none opacity-70 transition-transform group-hover:opacity-100", open && "rotate-90")} aria-hidden="true" />
      </button>
      <Collapse open={open}>
        <ol className="mt-1 space-y-0.5">
          {row.items.map((it, i) => (
            <li key={`${it.seq}:${it.itemId}:${i}`}>{it.kind === "tool" ? <ToolCall item={it} /> : <Prose item={it} quiet />}</li>
          ))}
        </ol>
      </Collapse>
    </div>
  );
}

/** The thread: user and assistant messages, tool calls (a finished run's folded under one line), requests (open
 *  ones as a form) and notices. */
export function MessageList({ sessionId, endedId = null, items, runs, pending, queued, critic, onAnswer, onLayout }: {
  /** For the user's images (attachmentUrl). */
  sessionId: string;
  /** The thread is this ended session's read-only transcript: images from its archive, no changes card (the session
   *  id may belong to a later session by now). */
  endedId?: string | null;
  items: ThreadItem[];
  /** Which runs ended and when: their work folds. */
  runs: RunRow[];
  pending: PendingRequest[];
  /** Runs still waiting behind the active one: their user message shows as queued. */
  queued: Set<string>;
  /** Runs the critic started: their "user" message is the critic's review, labelled as such. */
  critic: Set<string>;
  onAnswer: (requestId: string, answer: string) => Promise<void>;
  /** Content that loads on its own (the changes card) grew: the page re-pins its end if the user is there. */
  onLayout?: () => void;
}) {
  const rows = threadRows(items, runs);
  const anchor = endedId === null ? changesAnchor(items, runs) : null;
  // A notice is a run's failure only when that run failed (run.failed); "event for unknown run" also carries a runId.
  const failed = new Set(runs.filter((r) => r.status === "failed").map((r) => r.runId));
  return (
    <Transcript.Provider value={endedId}>
    <ol className="flex flex-col gap-4 sm:gap-5" aria-label="Conversation">
      {rows.map((row, i) => {
        if (row.type === "work") return <li key={`work:${row.runId}`} className="min-w-0"><WorkGroup row={row} /></li>;
        const it = row.item;
        const isQueued = it.runId !== null && queued.has(it.runId);
        // A tool right after another (a running run) sits close to it, like the rows of a fold.
        const toolRun = it.kind === "tool" && rows[i - 1]?.type === "item" && (rows[i - 1] as { item: ThreadItem }).item.kind === "tool";
        return (
          // A prompt opens a turn: a little more room above it, so prompt, work and answer read as one group.
          <li key={`${it.seq}:${it.runId}:${it.itemId}:${i}`} className={cn("min-w-0", toolRun && "-mt-4", opensTurn(rows, i) && "sm:mt-3")}>
            {it.kind === "user" ? (
              it.runId !== null && critic.has(it.runId)
                ? <CriticNote sessionId={sessionId} item={it} queued={isQueued} />
                : <UserMessage sessionId={sessionId} item={it} queued={isQueued} />
            ) : it.kind === "assistant" ? (
              <>
                <div className="group/answer relative">
                  <Prose item={it} />
                  {row.answer && <CopyAnswer text={it.text} />}
                </div>
                {anchor?.item === it && <ChangesCard sessionId={sessionId} refreshKey={anchor.endedSeq} onLayout={onLayout} />}
              </>
            ) : it.kind === "tool" ? (
              <ToolCall item={it} />
            ) : it.kind === "request" ? (
              <RequestItem item={it} pending={pending.find((p) => p.requestId === it.itemId)} onAnswer={onAnswer} />
            ) : (
              // A failed run's notice stays prominent, and so does one the user has to act on (tone "warn"); every other
              // notice (devd's, the bridge's) is a faint centred divider.
              it.runId !== null && failed.has(it.runId) ? (
                <p className="flex items-start gap-2 text-xs text-red-700 dark:text-red-400">
                  <CircleAlert className="mt-px size-3.5 flex-none" aria-hidden="true" />
                  <span className="min-w-0 break-words">{it.text}</span>
                </p>
              ) : it.tone === "warn" ? (
                <p className="flex items-start gap-2 text-xs text-amber-700 dark:text-amber-300">
                  <TriangleAlert className="mt-px size-3.5 flex-none" aria-hidden="true" />
                  <span className="min-w-0 break-words">{it.text}</span>
                </p>
              ) : (
                <p className="flex items-center gap-3 text-[0.6875rem] text-muted-foreground/70">
                  <span className="h-px flex-1 bg-border/60" aria-hidden="true" />
                  <span className="min-w-0 max-w-[80%] break-words text-center">{it.text}</span>
                  <span className="h-px flex-1 bg-border/60" aria-hidden="true" />
                </p>
              )
            )}
          </li>
        );
      })}
    </ol>
    </Transcript.Provider>
  );
}
