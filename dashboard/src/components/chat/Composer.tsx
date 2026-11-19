import { useEffect, useRef, useState, type ReactNode } from "react";
import { Send, Square, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ApiError } from "../../api";
import { prepareImage } from "../../imageView";
import { composerErrorText } from "../../threadView";

interface Attached { key: number; blob: Blob; url: string }

/** Message input: with a mouse/trackpad Enter sends and Shift+Enter is a newline; on touch Enter is a newline and
 *  the Send button sends. A message sent while a run is active is queued by the
 *  bridge and shows as queued in the thread. On a failed send the text stays and nothing is retried.
 *  Images pasted or dropped are scaled down (imageView.ts), previewed and go with the next message. */
export function Composer({ running, onSend, onStop, toolbar }: {
  running: boolean;
  /** Above the input: the session's model, account and harness switchers. */
  toolbar?: ReactNode;
  onSend: (text: string, images: Blob[]) => Promise<void>;
  onStop: () => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [images, setImages] = useState<Attached[]>([]);
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const nextKey = useRef(0);
  const urls = useRef(new Set<string>());
  useEffect(() => () => { for (const u of urls.current) URL.revokeObjectURL(u); }, []);

  const errorText = (e: unknown) => (e instanceof ApiError ? composerErrorText(e.status, e.body) : (e as Error).message);

  async function attach(files: File[]) {
    setErr(null);
    for (const file of files) {
      try {
        const blob = await prepareImage(file);
        const url = URL.createObjectURL(blob);
        urls.current.add(url);
        setImages((cur) => [...cur, { key: nextKey.current++, blob, url }]);
      } catch (e) { setErr(`${file.name || "image"}: ${(e as Error).message}`); }
    }
  }

  function detach(drop: Attached[]) {
    for (const a of drop) { URL.revokeObjectURL(a.url); urls.current.delete(a.url); }
    setImages((cur) => cur.filter((a) => !drop.includes(a)));
  }

  async function send() {
    if (busy || text.trim() === "") return;
    setBusy(true); setErr(null);
    const sent = text;
    const sentImages = images;
    // Text typed and images added while the send was in flight stay.
    try { await onSend(sent, sentImages.map((a) => a.blob)); setText((cur) => (cur === sent ? "" : cur)); detach(sentImages); }
    catch (e) { setErr(errorText(e)); }
    finally { setBusy(false); }
  }

  async function stop() {
    setStopping(true); setErr(null);
    try { await onStop(); }
    catch (e) { setErr(errorText(e)); }
    finally { setStopping(false); }
  }

  return (
    <form
      className="flex flex-col gap-1.5"
      onSubmit={(e) => { e.preventDefault(); void send(); }}
      onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) e.preventDefault(); }}
      onDrop={(e) => {
        if (e.dataTransfer.files.length === 0) return;
        e.preventDefault(); void attach(Array.from(e.dataTransfer.files));
      }}
    >
      {toolbar}
      {images.length > 0 && (
        <ul className="flex flex-wrap gap-2" aria-label="Attached images">
          {images.map((a) => (
            <li key={a.key} className="relative">
              <img src={a.url} alt="" className="size-16 rounded-md border object-cover" />
              <button
                type="button" aria-label="Remove image" title="Remove image" onClick={() => detach([a])}
                className="absolute -right-1.5 -top-1.5 flex size-5 items-center justify-center rounded-full border bg-background text-muted-foreground hover:text-foreground"
              >
                <X className="size-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-end gap-2">
        <textarea
          aria-label="Message"
          rows={2}
          placeholder={running ? "Message (queued after the current run)" : "Message the agent"}
          className="max-h-48 min-h-11 min-w-0 flex-1 resize-y rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            const files = Array.from(e.clipboardData.files);
            if (files.length === 0) return;
            e.preventDefault(); void attach(files);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && window.matchMedia("(pointer: fine)").matches) {
              e.preventDefault(); void send();
            }
          }}
        />
        {running && (
          <Button type="button" variant="outline" size="icon-lg" disabled={stopping} onClick={() => void stop()} aria-label="Stop the run" title="Stop the run">
            <Square className="fill-current" />
          </Button>
        )}
        <Button type="submit" size="icon-lg" disabled={busy || text.trim() === ""} aria-label="Send" title="Send">
          <Send />
        </Button>
      </div>
      {err && <p role="alert" className="text-sm text-destructive">{err}</p>}
    </form>
  );
}
