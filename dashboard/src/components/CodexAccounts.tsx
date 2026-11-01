import { FormDialog } from "./FormDialog";
import { QuotaBar } from "./QuotaBar";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { api, ApiError, type CodexAccountLogin, type CodexAccountsView, type CodexAccountView } from "../api";
import { ActionButton, ConfirmButton, Section } from "./primitives";
import { Gauge } from "./Gauge";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { measuredLabel, resetCountdown, usageSeverity } from "../accountsView";
import { codexIssue, codexStatus, codexWindowLabel } from "../subscriptionsView";
import { useNow } from "../store";

const touchButton = "min-h-11 sm:min-h-8";
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

function AddCodexAccount({ account, onDone, onClose }: { account?: CodexAccountView; onDone: () => Promise<void>; onClose: () => void }) {
  const [label, setLabel] = useState(account?.label ?? "");
  const [device, setDevice] = useState<(CodexAccountLogin & { expiresAt: number }) | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const now = useNow(1_000);
  const submitting = useRef(false);

  useEffect(() => {
    if (!device) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await (account ? api.codexAccountReauthStatus(device.id) : api.codexAccountLoginStatus(device.id));
        if (!active) return;
        setError(null);
        if (result.status === "done") {
          setDevice(null);
          await onDone();
          return;
        }
        if (result.status === "error") {
          setDevice(null);
          setError(result.error || "Login expired or failed. Start again to get a new code.");
          return;
        }
      } catch (e) {
        if (!active) return;
        setError(`Couldn't check sign-in. Retrying… ${errorMessage(e)}`);
      }
      if (active) timer = setTimeout(poll, 3_000);
    };
    timer = setTimeout(poll, 1_000);
    return () => { active = false; clearTimeout(timer); };
  }, [device, onDone, account]);

  async function start() {
    if (submitting.current || !label.trim()) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await (account ? api.codexAccountReauthStart(account.id) : api.codexAccountLoginStart(label.trim()));
      setDevice({ ...result, expiresAt: Date.now() + result.expiresInSec * 1_000 });
    } catch (e) { setError(errorMessage(e)); }
    finally { submitting.current = false; setBusy(false); }
  }

  async function cancel() {
    if (account) await api.codexAccountReauthCancel(account.id);
    else if (device) await api.codexAccountLoginCancel(device.id);
    setDevice(null);
    onClose();
  }

  const remainingMinutes = device
    ? Math.max(0, Math.ceil(Math.min(device.expiresInSec * 1_000, device.expiresAt - now) / 60_000))
    : 0;
  return (
    <FormDialog open onOpenChange={(open) => { if (!open) void cancel().catch((e) => setError(errorMessage(e))); }} busy={busy} title={account ? "Reconnect ChatGPT account" : "Add ChatGPT account"} description="Sign in on the web. Each account keeps its own quota and history."><div className="space-y-4">
      {device ? (
        <>
          <p className="text-sm">{account ? "Sign in to the account" : "Sign in to ChatGPT to add"} <span className="font-medium">{label.trim()}</span>.</p>
          <p className="text-xs text-muted-foreground">
            {account ? "Use the same ChatGPT account you used when adding this profile. If another account is signed in, open the link in a private window." : "Choose the ChatGPT account you want to add. Use a private browser window if another account is already signed in."}
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Button asChild variant="outline" className={touchButton}>
              <a href={device.url} target="_blank" rel="noopener noreferrer">{account ? "Open ChatGPT sign-in" : "Open ChatGPT sign-in"}</a>
            </Button>
            <span className="text-sm text-muted-foreground">Enter code:</span>
            <code className="select-all rounded-md border bg-muted px-3 py-2 font-mono text-lg tracking-wider">{device.code}</code>
          </div>
          <p role="status" className="text-xs text-muted-foreground">
            {remainingMinutes > 0 ? `Code expires in ${remainingMinutes} min. Waiting for sign-in…` : "Waiting for sign-in confirmation…"}
          </p>
        </>
      ) : (
        <form id="add-codex-account" onSubmit={(e) => { e.preventDefault(); void start(); }} className="space-y-5">
          {account ? <p className="text-sm">Reconnect {account.label}. History and linked sessions are preserved.</p> : <label className="grid gap-2 text-sm font-medium">
            Account name
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Personal or Work"
              maxLength={100} required disabled={busy} autoComplete="off" className="h-11 w-full text-base" />
          </label>}
        </form>
      )}
      {error && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}
      <div className="flex flex-wrap justify-end gap-2 border-t pt-4">
        <ActionButton variant="outline" className="min-h-11" disabled={busy} onError={setError} onAction={cancel}>Cancel</ActionButton>
        {!device && <Button type="submit" form="add-codex-account" disabled={busy || !label.trim()} aria-busy={busy} className="min-h-11">
          {busy ? "Starting sign-in…" : "Continue with ChatGPT"}
        </Button>}
      </div>
    </div></FormDialog>
  );
}

function CodexAccountCard({ account, preferred, busy, now, onRefresh, onToggle, onPrefer, onRemove, onSignIn, onError }: {
  account: CodexAccountView;
  preferred: boolean;
  busy: boolean;
  now: number;
  onRefresh: () => Promise<void>;
  onToggle: () => Promise<void>;
  onPrefer: () => Promise<void>;
  onRemove: () => Promise<void>;
  onSignIn: () => void;
  onError: (message: string) => void;
}) {
  const usage = account.usage;
  const status = account.disabled ? { text: "Disabled", tone: "warn" } : usage ? codexStatus(usage) : { text: "Usage pending", tone: "warn" };
  const issue = usage?.state === "signed-out" || usage?.state === "stale-login"
    ? "Renew the sign-in with the Sign in to this account button."
    : usage ? codexIssue(usage) : null;
  const measured = usage?.windows.filter((w): w is typeof w & { usedPct: number } => w.usedPct !== null && w.windowMinutes === 10080) ?? [];

  return (
    <Card><CardContent className="flex flex-1 flex-col gap-3 py-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="break-words font-medium">{account.label}</span>
            {usage?.planType && <Badge variant="outline" className="font-mono text-[10px]">{usage.planType}</Badge>}
          </div>
          <div className="mt-0.5 flex flex-wrap gap-1.5 text-xs text-muted-foreground">
            {account.isDefault && <span>Original account</span>}
            {preferred && <span className="font-medium text-foreground">Preferred for new launches</span>}
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <Badge variant={status.tone === "ok" ? "default" : status.tone === "danger" ? "destructive" : "secondary"}>{status.text}</Badge>
          {usage && <span className="text-[11px] text-muted-foreground">{measuredLabel(usage.fetchedAt, now)}</span>}
        </div>
      </div>
      {!!account.sharedUsageWith?.length && <p role="alert" className="rounded-md border border-destructive/50 bg-destructive/5 px-3 py-2 text-xs text-destructive">
        Same sign-in as {account.sharedUsageWith.join(", ")}. Both cards measure usage of the same ChatGPT account/workspace. Connect the correct account to track separate usage.
      </p>}
      {issue && <p className="rounded-md border border-destructive/50 bg-destructive/5 px-3 py-2 text-xs text-muted-foreground">{issue}</p>}
      {measured.length > 0 ? (
        <div className="space-y-2">{measured.map((window) => <QuotaBar key={window.kind} percent={window.usedPct} resetsAt={window.resetsAt} now={now} />)}</div>
      ) : <p className="text-xs text-muted-foreground">No weekly measurement available.</p>}
      {usage?.credits && (
        <div className="flex justify-between text-xs">
          <span className="text-muted-foreground">Credits</span>
          <span className="font-mono tabular-nums">{usage.credits.unlimited ? "unlimited" : usage.credits.balance ?? "—"}</span>
        </div>
      )}
      <div className="mt-auto flex flex-wrap gap-2">
        <Button size="sm" variant="outline" className={touchButton} disabled={busy} onClick={onSignIn}>
          Sign in to this account
        </Button>
        <ActionButton size="sm" variant="outline" className={touchButton} disabled={busy} onError={onError} onAction={onRefresh}>Refresh</ActionButton>
        <ActionButton size="sm" variant="outline" className={touchButton} disabled={busy || account.disabled || preferred}
          onError={onError} onAction={onPrefer}>{preferred ? "Preferred" : "Use for new launches"}</ActionButton>
        <ActionButton size="sm" variant="ghost" className={touchButton} disabled={busy} onError={onError} onAction={onToggle}>
          {account.disabled ? "Enable" : "Disable"}
        </ActionButton>
        {!account.isDefault && (
          <ConfirmButton size="sm" variant="ghost" className={touchButton} disabled={busy} confirmLabel="Delete account and history?"
            onError={onError} onConfirm={onRemove}>Remove</ConfirmButton>
        )}
      </div>
    </CardContent></Card>
  );
}

export function CodexAccounts({ fallback = null }: { fallback?: ReactNode }) {
  const [view, setView] = useState<CodexAccountsView | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [reauthAccount, setReauthAccount] = useState<CodexAccountView | undefined>();
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const request = useRef(0);
  const now = useNow(30_000);

  const reload = useCallback(async () => {
    const current = ++request.current;
    try {
      const result = await api.codexAccounts();
      if (current !== request.current) return;
      setView(result);
      setUnsupported(false);
      setFetchError(null);
    } catch (e) {
      if (current !== request.current) return;
      const missing = e instanceof ApiError && (e.status === 404 || e.status === 503);
      setUnsupported(missing);
      setFetchError(missing ? null : errorMessage(e));
    }
  }, []);

  useEffect(() => {
    void reload();
    const timer = setInterval(() => { void reload(); }, 60_000);
    return () => { clearInterval(timer); request.current++; };
  }, [reload]);

  const loginDone = useCallback(async () => {
    setAddOpen(false);
    setReauthAccount(undefined);
    setNotice(reauthAccount ? "Signed in. You can run co resume again in the original terminal." : "Account added.");
    await reload();
  }, [reload, reauthAccount]);

  async function change(action: () => Promise<unknown>) {
    setBusy(true);
    setActionError(null);
    try { await action(); await reload(); }
    finally { setBusy(false); }
  }

  if (unsupported) return fallback;
  return (
    <Section label="ChatGPT accounts" meta={
      <Button variant="outline" size="sm" className={touchButton} disabled={addOpen || !!reauthAccount}
        onClick={() => { setActionError(null); setAddOpen(true); }}>Add ChatGPT account</Button>
    }>
      {view && <div className="mb-3 flex flex-wrap items-center gap-3">
        <Badge variant="secondary">{view.preferredAccountId ? "Manual preference" : "Automatic selection"}</Badge>
        {!view.preferredAccountId && <span className="text-xs text-muted-foreground">Based on current usage</span>}
        {view.preferredAccountId && <ActionButton variant="outline" size="sm" className={touchButton} disabled={busy} onError={setActionError}
          onAction={() => change(() => api.preferCodexAccount(null))}>Use automatic selection</ActionButton>}
      </div>}
      {notice && <p role="status" className="mb-3 text-sm">{notice}</p>}
      {reauthAccount && <AddCodexAccount key={reauthAccount.id} account={reauthAccount} onDone={loginDone} onClose={() => setReauthAccount(undefined)} />}
      {addOpen && <AddCodexAccount onDone={loginDone} onClose={() => setAddOpen(false)} />}
      {fetchError && <p role="alert" className="mb-3 break-words text-sm text-destructive">Couldn't load ChatGPT accounts: {fetchError}</p>}
      {view === null ? (
        fetchError ? <ActionButton variant="outline" size="sm" className={touchButton} onAction={reload}>Retry</ActionButton> : <Skeleton className="h-56 w-full" />
      ) : view.accounts.length === 0 ? (
        <p className="text-sm text-muted-foreground">Add a ChatGPT account to use Codex.</p>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {view.accounts.map((account) => (
            <CodexAccountCard key={account.id} account={account} preferred={view.preferredAccountId === account.id} busy={busy || addOpen || !!reauthAccount} now={now}
              onSignIn={() => { setNotice(null); setActionError(null); setReauthAccount(account); }}
              onError={setActionError}
              onRefresh={() => change(() => api.refreshCodexAccount(account.id))}
              onToggle={() => change(() => api.updateCodexAccount(account.id, { disabled: !account.disabled }))}
              onPrefer={() => change(() => api.preferCodexAccount(account.id))}
              onRemove={() => change(() => api.deleteCodexAccount(account.id))} />
          ))}
        </div>
      )}
      {actionError && <p role="alert" className="mt-3 break-words text-sm text-destructive">{actionError}</p>}
    </Section>
  );
}
