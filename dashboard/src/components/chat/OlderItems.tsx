import { useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { anchorRow, type RowAnchor } from "./olderAnchor";

/** Above a thread loaded only to some point back (threadView THREAD_PAGE): loads the page before it. The page scrolls
 *  as a whole (window); the first row in view keeps its place on screen while older items go in above it, also when
 *  new ones arrive at the end meanwhile, or when it folded into its run's group (MessageList data-row-key). */
export function OlderItems({ firstSeq, more, load }: { firstSeq: number | undefined; more: boolean; load: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const anchor = useRef<RowAnchor | null>(null);
  useLayoutEffect(() => {
    const a = anchor.current;
    if (a === null) return;
    anchor.current = null;
    const el = anchorRow(Array.from(document.querySelectorAll<HTMLElement>("[data-row-key]")), a);
    if (el) window.scrollBy({ top: el.getBoundingClientRect().top - a.top });
  }, [firstSeq]);
  if (!more) return null;
  const click = () => {
    setBusy(true);
    setErr(null);
    const rows = Array.from(document.querySelectorAll<HTMLElement>("[data-row-key]"));
    const first = rows.find((r) => r.getBoundingClientRect().bottom > 0);
    anchor.current = first ? { key: first.dataset.rowKey!, run: first.dataset.rowRun ?? null, top: first.getBoundingClientRect().top } : null;
    load().then(() => setBusy(false), (e) => { anchor.current = null; setBusy(false); setErr((e as Error).message); });
  };
  return (
    <div className="mb-5 flex flex-col items-center gap-1.5">
      <Button type="button" variant="outline" size="sm" disabled={busy} onClick={click}>{busy ? "Loading…" : "Load earlier messages"}</Button>
      {err && <p role="alert" className="text-sm text-destructive">Could not load earlier messages: {err}</p>}
    </div>
  );
}
