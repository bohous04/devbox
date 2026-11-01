import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type CodexAccountSwitchResponse, type CodexSessionAccountsView } from "../api";
import { ActionButton, ConfirmButton } from "./primitives";

/** Mounted only inside an expanded, running Codex session. */
export function SessionCodexAccount({ sessionId, onChanged }: {
  sessionId: string;
  onChanged: () => Promise<void>;
}) {
  const [data, setData] = useState<CodexSessionAccountsView | null>(null);
  const [pick, setPick] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    const next = await api.sessionCodexAccounts(sessionId);
    setData(next);
    return next;
  }, [sessionId]);

  useEffect(() => {
    let alive = true;
    api.sessionCodexAccounts(sessionId)
      .then((next) => { if (alive) setData(next); })
      .catch((err: Error) => { if (alive) setError(err.message); });
    return () => { alive = false; };
  }, [sessionId]);

  const finish = useCallback(async (result: CodexAccountSwitchResponse) => {
    if (!result.ok) throw new Error(result.error ?? "Some panels could not switch accounts. Check the current accounts below and retry.");
    setPick(null);
    setNotice(`Codex is now using ${result.label}. Existing conversation history was preserved.`);
    await onChanged();
  }, [onChanged]);

  // A large conversation (hundreds of agents) keeps switching after its request
  // returned; follow it until devd reports the result, also after a page reload.
  const background = !!data?.switching;
  useEffect(() => {
    if (!background) return;
    let alive = true;
    setBusy(true);
    setNotice("Switching… Large conversations with many agents can take several minutes.");
    const timer = setInterval(() => {
      refresh().then(async (next) => {
        if (!alive || next.switching) return;
        setNotice(null);
        setBusy(false);
        if (next.lastSwitch) await finish(next.lastSwitch);
      }).catch((err: Error) => { if (alive) { setNotice(null); setError(err.message); } });
    }, 3000);
    return () => { alive = false; clearInterval(timer); };
  }, [background, refresh, finish]);

  const label = (id: string | null) => data?.accounts.find((a) => a.id === id)?.label ?? id ?? "Unknown account";
  const pending = data?.panes.find((p) => p.pending)?.pending;
  const selected = pending?.accountId ?? pick ?? data?.currentAccountId ?? "";
  const target = data?.accounts.find((a) => a.id === selected);
  const unchanged = !!data?.panes.length && data.panes.every((p) => !p.pending && p.accountId === selected);
  const currentLabel = !data ? "Loading…" : !data.panes.length ? "No running Codex panel"
    : pending ? "Switch unfinished" : data.currentAccountId ? label(data.currentAccountId)
    : data.panes.some((p) => p.accountId === null) ? "Unknown account" : "Mixed accounts";

  return (
    <div className="flex flex-col gap-2 rounded-md border bg-muted/40 px-3 py-2 text-xs" aria-label="Codex account settings">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground">Codex account</span>
        <span className="min-w-0 break-words font-medium" aria-label="Current Codex account">{currentLabel}</span>
        <span className="flex-1" />
        {data && (
          <>
            <select
              aria-label="Codex account"
              className="h-8 w-full min-w-0 rounded-md border bg-background px-2 text-xs text-foreground sm:w-auto sm:max-w-64"
              value={selected}
              disabled={busy || !!pending || !data.panes.length}
              onChange={(e) => { setPick(e.target.value); setError(null); setNotice(null); }}
            >
              {!data.accounts.some((a) => a.id === selected) && <option value={selected} disabled>Select account</option>}
              {data.accounts.map((a) => (
                <option key={a.id} value={a.id} disabled={!a.available || a.disabled}>
                  {a.label}{!a.available || a.disabled ? ` — ${a.unavailableReason ?? "disabled"}` : ""}
                </option>
              ))}
            </select>
            <ConfirmButton
              key={`${selected}:${data.panes.map((p) => `${p.target}:${p.accountId}:${p.pending?.phase ?? ""}`).join(",")}`}
              size="sm" variant="outline" confirmLabel={pending ? "Resume conversations?" : "Switch and continue?"}
              disabled={busy || !target?.available || target.disabled || unchanged || !data.panes.length}
              onError={setError}
              onConfirm={async () => {
                setBusy(true);
                setError(null);
                setNotice(null);
                let running = false;
                try {
                  const result = await api.switchCodexAccount(sessionId, selected);
                  running = "running" in result;
                  await refresh();
                  if (!("running" in result)) await finish(result);
                } catch (err) {
                  // Even an interrupted request may have switched a subset of panels.
                  await refresh().catch(() => {});
                  throw err;
                } finally {
                  // A background switch stays busy until its polling reports the result.
                  if (!running) setBusy(false);
                }
              }}
            >{pending ? "Finish switching" : "Switch account"}</ConfirmButton>
          </>
        )}
        <ActionButton size="sm" variant="ghost" disabled={busy} onError={setError}
          onAction={async () => { await refresh(); setError(null); }}>Refresh accounts</ActionButton>
      </div>
      {data && data.panes.length > 0 && (
        <p className="text-muted-foreground">Switching keeps existing conversation history. A new, empty conversation starts with the selected account. If history cannot be safely transferred, the switch stops.</p>
      )}
      {pending && (
        <p role="status">The switch to {label(pending.accountId)} is unfinished. Finish switching to resume the saved conversations.</p>
      )}
      {data && !data.currentAccountId && data.panes.length > 0 && (
        <ul className="space-y-1 text-muted-foreground">
          {data.panes.map((p) => <li key={p.target}>{p.target}: {p.pending ? `Resume pending · ${label(p.pending.accountId)}` : label(p.accountId)}</li>)}
        </ul>
      )}
      {data && (
        <div className="text-muted-foreground">
          {data.accounts.some((a) => !a.available && !a.disabled) && "Some accounts are unavailable in this session. "}
          <Link className="underline underline-offset-2 hover:text-foreground" to="/subscriptions">Manage Codex accounts</Link>
        </div>
      )}
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert" className="font-medium text-destructive">{error}</p>}
    </div>
  );
}
