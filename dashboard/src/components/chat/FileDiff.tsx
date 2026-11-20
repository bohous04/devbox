import { useCallback, useEffect, useState } from "react";
import { Loader2, RotateCw } from "lucide-react";
import type { SessionFileDiff } from "@/api";
import { cn } from "@/lib/utils";
import { changesError } from "../../changesView";
import { escapeInvisible, parseUnifiedDiff, type DiffLine } from "../../diffView";

const LINE: Record<DiffLine["kind"], string> = {
  add: "bg-emerald-500/[0.12] text-emerald-900 dark:bg-emerald-400/[0.10] dark:text-emerald-200",
  del: "bg-red-500/[0.10] text-red-900 dark:bg-red-400/[0.10] dark:text-red-200",
  hunk: "bg-muted/60 text-muted-foreground",
  note: "text-muted-foreground italic",
  ctx: "text-foreground/80",
};
const SIGN: Record<DiffLine["kind"], string> = { add: "+", del: "−", hunk: "", note: "", ctx: "" };

/** A diff line's text with invisible and direction-changing characters shown as muted escapes. */
function DiffText({ text }: { text: string }) {
  return escapeInvisible(text).map((p, i) => p.escaped
    ? <span key={i} title="Invisible character" className="rounded-sm bg-foreground/[0.06] text-muted-foreground">{p.text}</span>
    : p.text);
}

/** One changed file's diff, fetched when it is opened. Long lines scroll sideways inside the block, not the page. */
export function FileDiff({ path, fetchDiff, onLayout }: {
  path: string;
  /** The card's cached, rate-limited fetch. */
  fetchDiff: (path: string) => Promise<SessionFileDiff>;
  onLayout?: () => void;
}) {
  const [diff, setDiff] = useState<SessionFileDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    let alive = true;
    setError(null); setDiff(null);
    fetchDiff(path).then(
      (d) => { if (alive) setDiff(d); },
      (e) => { if (alive) setError(changesError(e)); },
    );
    return () => { alive = false; };
  }, [fetchDiff, path]);
  useEffect(() => load(), [load]);
  useEffect(() => { onLayout?.(); }, [diff, error, onLayout]);

  const note = "px-3 py-2 font-sans text-xs text-muted-foreground";
  if (error !== null) {
    return (
      <p role="status" className={cn(note, "flex items-center gap-2")}>
        <span title={error}>Couldn't load the diff</span>
        <button type="button" onClick={() => load()} className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-foreground/80 transition-colors hover:bg-muted/60 hover:text-foreground">
          <RotateCw className="size-3" aria-hidden="true" />Retry
        </button>
      </p>
    );
  }
  if (diff === null) return <p role="status" className={cn(note, "flex items-center gap-2")}><Loader2 className="size-3 animate-spin" aria-hidden="true" />Loading diff…</p>;
  if (diff.binary) return <p className={note}>Binary file, no text diff</p>;
  const lines = parseUnifiedDiff(diff.diff);
  if (lines.length === 0) return <p className={note}>No line changes</p>;
  return (
    <div className="border-y border-border/50 bg-background/60">
      <div className="max-h-[28rem] overflow-auto">
        <table className="w-max min-w-full border-collapse font-mono text-[0.75rem] leading-5">
          <tbody>
            {lines.map((l, i) => (
              <tr key={i} className={LINE[l.kind]}>
                {l.kind === "hunk" || l.kind === "note"
                  ? <td colSpan={4} className="whitespace-pre px-3"><DiffText text={l.text} /></td>
                  : <>
                    {/* Line numbers are for reading only: not selected when the diff text is copied. */}
                    <td className="w-px select-none whitespace-nowrap pl-3 pr-1.5 text-right text-muted-foreground/60 tabular-nums">{l.old ?? ""}</td>
                    <td className="w-px select-none whitespace-nowrap pr-2 text-right text-muted-foreground/60 tabular-nums">{l.new ?? ""}</td>
                    <td className="w-px select-none pr-1.5 text-center" aria-hidden="true">{SIGN[l.kind]}</td>
                    <td className="whitespace-pre pr-4"><span className="sr-only">{l.kind === "add" ? "added: " : l.kind === "del" ? "removed: " : ""}</span><DiffText text={l.text} /></td>
                  </>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {diff.truncated && <p className={note}>Diff truncated: the rest of this file's changes are not shown.</p>}
    </div>
  );
}
