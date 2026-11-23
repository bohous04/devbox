import { useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

/** Above a thread loaded only to some point back (threadView THREAD_PAGE): loads the page before it. The page scrolls
 *  as a whole (window), so what the user reads keeps its place while the older items go in above it. */
export function OlderItems({ firstSeq, more, load }: { firstSeq: number | undefined; more: boolean; load: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Distance from the page's end when the load started; restored once the older items are in.
  const fromEnd = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (fromEnd.current === null) return;
    window.scrollTo({ top: document.documentElement.scrollHeight - fromEnd.current });
    fromEnd.current = null;
  }, [firstSeq]);
  if (!more) return null;
  const click = () => {
    setBusy(true);
    setErr(null);
    fromEnd.current = document.documentElement.scrollHeight - window.scrollY;
    load().then(() => setBusy(false), (e) => { fromEnd.current = null; setBusy(false); setErr((e as Error).message); });
  };
  return (
    <div className="mb-5 flex flex-col items-center gap-1.5">
      <Button type="button" variant="outline" size="sm" disabled={busy} onClick={click}>{busy ? "Loading…" : "Load earlier messages"}</Button>
      {err && <p role="alert" className="text-sm text-destructive">Could not load earlier messages: {err}</p>}
    </div>
  );
}
