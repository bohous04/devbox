import { useEffect, useState } from "react";
import { Check, Copy, TriangleAlert } from "lucide-react";
import { api, type ActiveShare, type CreatedShare, type SessionLive } from "../api";
import { SHARE_PRESETS, TAINT_ACTION, TAINT_MESSAGE, shareExpiryLabel, shareWarning, taintedWithoutShare } from "../shareView";
import { useNow } from "../store";
import { FormDialog } from "./FormDialog";
import { ActionButton, ConfirmButton, Section } from "./primitives";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

/** "Share terminal" dialog: validity choice, warning, after creation the link + Copy.
 *  devd returns the link with the token only once (POST) — after closing the dialog it cannot be shown. */
export function ShareTerminalDialog({ sessionId, title, open, onOpenChange, onCreated }: {
  sessionId: string; title: string; open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: () => void;
}) {
  const now = useNow(1000);
  const [minutes, setMinutes] = useState(SHARE_PRESETS[0].minutes);
  const [created, setCreated] = useState<CreatedShare | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Each opening starts clean — the old link is not shown again.
  useEffect(() => {
    if (open) { setCreated(null); setErr(null); setCopied(false); setMinutes(SHARE_PRESETS[0].minutes); }
  }, [open]);

  async function create() {
    setBusy(true); setErr(null);
    try {
      setCreated(await api.createShare(sessionId, minutes));
      onCreated?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setErr("Copy failed — select the link and copy it manually.");
    }
  }

  const expiresAt = created?.expiresAt ?? now + minutes * 60_000;

  return (
    <FormDialog open={open} onOpenChange={onOpenChange} busy={busy} title="Share terminal" description={`Give someone a temporary link to the terminal of ${title}.`}>
      <div className="flex flex-col gap-4">
        {!created && (
          <div role="radiogroup" aria-label="Link valid for" className="flex flex-wrap gap-2">
            {SHARE_PRESETS.map((p) => (
              <Button key={p.minutes} type="button" role="radio" aria-checked={minutes === p.minutes} variant={minutes === p.minutes ? "default" : "outline"} disabled={busy} onClick={() => setMinutes(p.minutes)}>
                {p.label}
              </Button>
            ))}
          </div>
        )}
        <p className="flex gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <span>{shareWarning(expiresAt, now)}</span>
        </p>
        {created ? (
          <>
            <div className="flex gap-2">
              <Input readOnly aria-label="Share link" value={created.url} onFocus={(e) => e.currentTarget.select()} className="font-mono text-xs" />
              <Button type="button" variant="outline" onClick={copy}>{copied ? <Check className="size-4" /> : <Copy className="size-4" />}{copied ? "Copied" : "Copy"}</Button>
            </div>
            <p className="text-xs text-muted-foreground">This link is shown only now. Revoke it any time under Active shares.</p>
            <div className="flex justify-end"><Button type="button" onClick={() => onOpenChange(false)}>Done</Button></div>
          </>
        ) : (
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="button" disabled={busy} onClick={create}>{busy ? "Creating…" : "Create link"}</Button>
          </div>
        )}
        {err && <p role="alert" className="text-sm text-destructive">{err}</p>}
      </div>
    </FormDialog>
  );
}

/** List of active shares with Revoke and below it sessions whose sharing ended but
 *  whose container is still restricted (taint) — with a rebuild offer. Hidden until there is something to show.
 *  `version` = reload (the page bumps it after creating a share); `onChanged` = refresh
 *  the session list after a rebuild. */
export function ActiveShares({ sessions, version, onChanged }: { sessions: SessionLive[]; version: number; onChanged?: () => void | Promise<void> }) {
  const now = useNow(1000);
  const [shares, setShares] = useState<ActiveShare[]>([]);
  const [err, setErr] = useState<string | null>(null);

  const load = () => api.shares().then((r) => { setShares(r); setErr(null); }).catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  useEffect(() => {
    void load();
    const h = setInterval(load, 15_000);
    return () => clearInterval(h);
  }, [version]);

  const visible = shares.filter((s) => s.expires_at > now);
  const tainted = taintedWithoutShare(sessions, shares, now);
  if (visible.length === 0 && tainted.length === 0 && !err) return null;
  const label = (s: ActiveShare) => s.name?.trim() || sessions.find((x) => x.id === s.session_id)?.repo || s.session_id;

  return (
    <Section label="Active shares" meta={<span className="text-xs text-muted-foreground">{visible.length}</span>}>
      <Card><CardContent className="flex flex-col divide-y p-0">
        {visible.map((s) => (
          <div key={s.id} className="flex items-center gap-3 px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{label(s)}</p>
              <p className="text-xs text-muted-foreground">Valid until {shareExpiryLabel(s.expires_at, now)}</p>
            </div>
            <ConfirmButton variant="outline" confirmLabel="Revoke?" onConfirm={async () => { await api.revokeShare(s.id); await load(); }} onError={setErr}>
              Revoke
            </ConfirmButton>
          </div>
        ))}
        {tainted.map((s) => (
          <div key={`taint-${s.id}`} className="flex items-center gap-3 px-4 py-3">
            <TriangleAlert className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{s.name?.trim() || s.repo}</p>
              <p className="text-xs text-muted-foreground">{TAINT_MESSAGE}</p>
            </div>
            <ConfirmButton variant="outline" confirmLabel={`${TAINT_ACTION}?`} onConfirm={async () => { await api.recreateSession(s.id); await onChanged?.(); }} onError={setErr}>
              {TAINT_ACTION}
            </ConfirmButton>
          </div>
        ))}
        {err && <p role="alert" className="flex items-center justify-between gap-3 px-4 py-3 text-sm text-destructive">{err}<ActionButton size="sm" variant="ghost" onAction={load}>Retry</ActionButton></p>}
      </CardContent></Card>
    </Section>
  );
}
