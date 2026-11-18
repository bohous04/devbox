import { useState } from "react";
import { Send, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ApiError } from "../../api";
import { composerErrorText } from "../../threadView";

/** Message input: with a mouse/trackpad Enter sends and Shift+Enter is a newline; on touch Enter is a newline and
 *  the Send button sends. A message sent while a run is active is queued by the
 *  bridge and shows as queued in the thread. On a failed send the text stays and nothing is retried. */
export function Composer({ running, onSend, onStop }: {
  running: boolean;
  onSend: (text: string) => Promise<void>;
  onStop: () => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const errorText = (e: unknown) => (e instanceof ApiError ? composerErrorText(e.status, e.body) : (e as Error).message);

  async function send() {
    if (busy || text.trim() === "") return;
    setBusy(true); setErr(null);
    const sent = text;
    // Text typed while the send was in flight stays.
    try { await onSend(sent); setText((cur) => (cur === sent ? "" : cur)); }
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
    <form className="flex flex-col gap-1.5" onSubmit={(e) => { e.preventDefault(); void send(); }}>
      <div className="flex items-end gap-2">
        <textarea
          aria-label="Message"
          rows={2}
          placeholder={running ? "Message (queued after the current run)" : "Message the agent"}
          className="max-h-48 min-h-11 min-w-0 flex-1 resize-y rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          value={text}
          onChange={(e) => setText(e.target.value)}
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
