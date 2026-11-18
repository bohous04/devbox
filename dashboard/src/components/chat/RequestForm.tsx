import { useState } from "react";
import type { PendingRequest } from "../../../../shared/thread";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ApiError } from "../../api";
import { composerErrorText } from "../../threadView";
import { Markdown } from "./Markdown";

// The bridge approves a plan only on exactly this answer; any other text rejects it as feedback
// (PLAN_APPROVE in image/agent-bridge/src/claudeSession.ts).
const PLAN_APPROVE = "Approve";

/** An open request the agent is waiting on: a question (options as buttons, multi-select when the request says
 *  so, free text), a plan (Approve, or reject with feedback) or an approval (its options). */
export function RequestForm({ request, onAnswer }: { request: PendingRequest; onAnswer: (answer: string) => Promise<void> }) {
  const [text, setText] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const isPlan = request.kind === "plan";

  async function send(answer: string) {
    if (busy || answer === "") return;
    setBusy(true); setErr(null);
    try { await onAnswer(answer); }
    catch (e) { setErr(e instanceof ApiError ? composerErrorText(e.status, e.body) : (e as Error).message); }
    finally { setBusy(false); }
  }

  const toggle = (label: string) => setPicked((p) => (p.includes(label) ? p.filter((x) => x !== label) : [...p, label]));

  return (
    <div className="rounded-lg border border-amber-600/40 bg-amber-500/5 p-3">
      <p className="mb-2 text-xs font-medium uppercase tracking-wider text-amber-700 dark:text-amber-400">
        {isPlan ? "Plan for approval" : request.kind === "approval" ? "Approval needed" : "Question"}
      </p>
      <div className="text-sm"><Markdown text={request.prompt} /></div>
      {isPlan ? (
        <div className="mt-3 flex flex-col gap-2">
          <Button type="button" className="self-start" disabled={busy} onClick={() => void send(PLAN_APPROVE)}>Approve</Button>
          <form className="flex flex-col gap-2 sm:flex-row" onSubmit={(e) => { e.preventDefault(); void send(text.trim()); }}>
            <Input aria-label="Feedback to reject the plan" placeholder="What should change?" value={text} disabled={busy} onChange={(e) => setText(e.target.value)} />
            <Button type="submit" variant="outline" disabled={busy || text.trim() === ""}>Reject with feedback</Button>
          </form>
        </div>
      ) : (
        <div className="mt-3 flex flex-col gap-2">
          {request.options && request.options.length > 0 && (
            <div className="flex flex-wrap gap-2" role={request.multiSelect ? "group" : undefined} aria-label="Options">
              {request.options.map((o) => (
                <Button
                  key={o.label} type="button" disabled={busy}
                  variant={request.multiSelect && picked.includes(o.label) ? "default" : "outline"}
                  aria-pressed={request.multiSelect ? picked.includes(o.label) : undefined}
                  className="h-auto min-h-9 max-w-full flex-col items-start gap-0.5 whitespace-normal py-1.5 text-left"
                  onClick={() => (request.multiSelect ? toggle(o.label) : void send(o.label))}
                >
                  <span>{o.label}</span>
                  {o.description && <span className="text-xs font-normal opacity-70">{o.description}</span>}
                </Button>
              ))}
              {/* Claude's AskUserQuestion takes the picked labels of a multi-select question comma-separated. */}
              {request.multiSelect && <Button type="button" disabled={busy || picked.length === 0} onClick={() => void send(picked.join(", "))}>Send selection</Button>}
            </div>
          )}
          <form className="flex flex-col gap-2 sm:flex-row" onSubmit={(e) => { e.preventDefault(); void send(text.trim()); }}>
            <Input aria-label="Your answer" placeholder="Answer in your own words" value={text} disabled={busy} onChange={(e) => setText(e.target.value)} />
            <Button type="submit" variant="outline" disabled={busy || text.trim() === ""}>Send</Button>
          </form>
        </div>
      )}
      {err && <p role="alert" className="mt-2 text-sm text-destructive">{err}</p>}
    </div>
  );
}
