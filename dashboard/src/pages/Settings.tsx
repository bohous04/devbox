import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { FormDialog } from "../components/FormDialog";
import { api, type AccountView, type AuthProvider, type AuthStatus, type GiteaInstanceInfo } from "../api";
import { ActionButton, AppPage, ConfirmButton, Section, SecretInput } from "../components/primitives";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  CODE_SUBMIT_IDLE, canSubmitCode, codeSubmitFailed, codeSubmitStart, codeSubmitSucceeded, providerBadge, showAgyRow,
  type CodeSubmitState,
} from "../authView";
import { useStore } from "../store";
import {
  SETTING_BOUNDS, addGiteaInstance, cloneConfig, configIssues, criticModelSuggestions, giteaIssues, getAccountPool, getCritic, mergeSettings,
  removeGiteaInstance, removeProjectPin, setAccountPool, setCritic, setProjectPin, updateGiteaInstance,
  updateSetting, validateConfig,
  type DevConfig, type NumericSettingKey,
} from "../configEdit";

/* ============================== small blocks ============================== */

function NumField({ label, hint, unit, k, value, onChange }: {
  label: string; hint: string; unit: string; k: NumericSettingKey; value: number;
  onChange: (k: NumericSettingKey, v: number) => void;
}) {
  const b = SETTING_BOUNDS[k];
  const bad = !Number.isInteger(value) || value < b.min || value > b.max;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</span>
      <div className="flex items-center gap-2">
        <Input
          className={cn("h-8 max-w-[110px] text-right font-mono text-sm tabular-nums", bad && "border-destructive text-destructive")}
          type="number" min={b.min} max={b.max} step={1}
          value={Number.isFinite(value) ? value : ""}
          onChange={(e) => onChange(k, e.target.value === "" ? NaN : Number(e.target.value))}
          aria-label={label}
        />
        <span className="text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">{unit}</span>
      </div>
      <span className="text-[10.5px] text-muted-foreground">{hint}</span>
    </div>
  );
}

// The slider layout alone, without any tie to where the value comes from. Extracted
// from SliderField so the pool thresholds can use it too — they live in the nested
// settings.accountPool and are written via setAccountPool, so they do not fit the keyed
// SliderField. Widening NumericSettingKey for them would loosen that type again
// (exactly what was recently fixed there), and copies of the layout would
// drift apart at the first change of appearance.
function PercentSlider({ label, hint, min, max, value, onChange }: {
  label: string; hint: string; min: number; max: number; value: number; onChange: (v: number) => void;
}) {
  const safe = Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</span>
      <div className="flex items-center gap-2.5">
        <input className="min-w-[90px] flex-1 accent-foreground" type="range" min={min} max={max} step={1}
          value={safe} onChange={(e) => onChange(Number(e.target.value))} aria-label={label} />
        <span className="min-w-[44px] flex-none text-right font-mono text-sm font-semibold tabular-nums">
          {Number.isFinite(value) ? `${value} %` : "— %"}
        </span>
      </div>
      <span className="text-[10.5px] text-muted-foreground">{hint}</span>
    </div>
  );
}

function SliderField({ label, hint, k, value, onChange }: {
  label: string; hint: string; k: NumericSettingKey; value: number;
  onChange: (k: NumericSettingKey, v: number) => void;
}) {
  const b = SETTING_BOUNDS[k];
  return <PercentSlider label={label} hint={hint} min={b.min} max={b.max} value={value} onChange={(v) => onChange(k, v)} />;
}

function GiteaTokenControl({ name, info, onSaved }: {
  name: string; info: GiteaInstanceInfo | undefined; onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  function close() { setOpen(false); setToken(""); }
  async function saveToken() {
    if (!token.trim() || busy) return;
    setBusy(true); setMsg(null);
    try {
      const r = await api.giteaSetToken(name, token.trim());
      setMsg({ ok: true, text: `Logged in as ${r.login}` });
      close(); onSaved();
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
    finally { setBusy(false); }
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Badge variant="outline">{info ? (info.hasToken ? "Token saved" : "No token") : "Not saved"}</Badge>
      <Button variant="outline" size="sm" disabled={!info} title={info ? undefined : "Save the configuration first (Save + push)"} onClick={() => { setOpen(true); setMsg(null); }}>{info?.hasToken ? "Replace token" : "Add token"}</Button>
      <FormDialog open={open} onOpenChange={(next) => { if (!next) close(); }} busy={busy} title={`Gitea token · ${name}`} description="Create an access token in Gitea → Settings → Applications with read:repository and read:user permissions.">
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void saveToken(); }}>
          <label className="grid gap-1.5 text-sm font-medium">Access token<SecretInput required value={token} onChange={(e) => setToken(e.target.value)} /></label>
          {msg && !msg.ok && <p role="alert" className="text-sm text-destructive">{msg.text}</p>}
          <div className="flex justify-end gap-2"><Button type="button" variant="ghost" disabled={busy} onClick={close}>Cancel</Button><Button type="submit" disabled={busy || !token.trim()}>{busy ? "Saving…" : "Save token"}</Button></div>
        </form>
      </FormDialog>
      {msg?.ok && <span role="status" className="text-xs text-muted-foreground">{msg.text}</span>}
    </div>
  );
}

/* ============================== agent logins ============================== */

// expiresInSec is optional: Grok Build does not have it (the real code validity period was
// never measured, see devd/src/agentAuth.ts grokLoginStart), Codex does.
type Device = { url: string; code: string; expiresInSec?: number };
type LoginPollStatus = { status: "pending" | "done" | "error" };

/** A closed or replaced dialog invalidates pending requests as well as its timer.
 * Polls run serially so a slow status endpoint cannot overlap itself. These
 * legacy login endpoints expose no server cancellation; closing stops UI polling. */
function useLoginDialog<T>(start: () => Promise<T>, pollStatus: () => Promise<LoginPollStatus>, onDone: () => Promise<void>, onError: (message: string) => void) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function invalidate() { generation.current++; if (timer.current) clearTimeout(timer.current); timer.current = null; }
  useEffect(() => () => { invalidate(); }, []);
  function close() { invalidate(); setOpen(false); setData(null); setError(null); }
  async function begin() {
    invalidate(); const run = generation.current;
    setOpen(true); setData(null); setError(null);
    try {
      const result = await start();
      if (run !== generation.current) return;
      setData(result);
      async function check() {
        try {
          const result = await pollStatus();
          if (run !== generation.current) return;
          if (result.status === "done") { close(); await onDone(); return; }
          if (result.status === "error") { const message = "Login expired or failed. Close this dialog and try again."; setError(message); onError(message); return; }
        } catch { /* A temporary status failure should not interrupt login. */ }
        if (run === generation.current) timer.current = setTimeout(check, 3000);
      }
      timer.current = setTimeout(check, 3000);
    } catch (e) { if (run === generation.current) { const message = (e as Error).message; setError(message); onError(message); } }
  }
  return { open, data, error, begin, close };
}

function DeviceLoginRow({ label, loginLabel, status, start, pollStatus, onDone, onError, onLogout }: {
  label: string; loginLabel: string; status: AuthProvider; start: () => Promise<Device>;
  pollStatus: () => Promise<LoginPollStatus>; onDone: () => Promise<void>;
  onError: (msg: string) => void; onLogout?: () => Promise<void>;
}) {
  const login = useLoginDialog(start, pollStatus, onDone, onError);
  const device = login.data;
  const b = providerBadge(status);
  return (
    <div className="flex flex-wrap items-center gap-3 py-2">
      <span className="w-36 shrink-0 text-sm font-medium">{label}</span>
      <Badge variant={b.tone === "ok" ? "default" : "secondary"}>{b.text}</Badge>
      <span className="min-w-0 break-words text-sm text-muted-foreground">{status.detail}</span>
      <span className="flex-1" />
      {!status.loggedIn && <Button size="sm" onClick={() => void login.begin()}>{loginLabel}</Button>}
      {status.loggedIn && onLogout && <ActionButton size="sm" variant="ghost" onError={onError} onAction={async () => { await onLogout(); await onDone(); }}>Log out</ActionButton>}
      <FormDialog open={login.open} onOpenChange={(next) => { if (!next) login.close(); }} title={loginLabel} description={`Connect ${label}. Finish signing in in the provider's browser window.`}>
        <div className="space-y-4">
          {!device && !login.error && <p role="status" className="text-sm text-muted-foreground">Preparing sign-in…</p>}
          {device && <>
            <p className="text-sm">1. Open <a className="break-all underline" href={device.url} target="_blank" rel="noreferrer">{device.url}</a></p>
            <p className="text-sm">2. Enter this code:</p>
            <div className="select-all rounded-md border bg-muted px-4 py-3 font-mono text-2xl tracking-widest">{device.code}</div>
            {!login.error && <p role="status" className="text-sm text-muted-foreground">{device.expiresInSec != null ? `Expires in ${Math.round(device.expiresInSec / 60)} minutes. ` : ""}Waiting for sign-in…</p>}
          </>}
          {login.error && <p role="alert" className="text-sm text-destructive">{login.error}</p>}
          <div className="flex justify-end"><Button variant="outline" onClick={login.close}>Close</Button></div>
        </div>
      </FormDialog>
    </div>
  );
}

function UrlLoginRow({ label, loginLabel, status, start, pollStatus, onDone, onError }: {
  label: string; loginLabel: string; status: AuthProvider;
  start: () => Promise<{ url: string; bridge?: "ok" | "unavailable" }>;
  pollStatus: () => Promise<LoginPollStatus>; onDone: () => Promise<void>; onError: (msg: string) => void;
}) {
  const login = useLoginDialog(start, pollStatus, onDone, onError);
  const b = providerBadge(status);
  return (
    <div className="flex flex-wrap items-center gap-3 py-2">
      <span className="w-36 shrink-0 text-sm font-medium">{label}</span>
      <Badge variant={b.tone === "ok" ? "default" : "secondary"}>{b.text}</Badge>
      <span className="min-w-0 break-words text-sm text-muted-foreground">{status.detail}</span><span className="flex-1" />
      {!status.loggedIn && <Button size="sm" onClick={() => void login.begin()}>{loginLabel}</Button>}
      <FormDialog open={login.open} onOpenChange={(next) => { if (!next) login.close(); }} title={`${label} sign-in`} description="Open the provider's sign-in page to connect this proxy account.">
        <div className="space-y-4">
          {!login.data && !login.error && <p role="status" className="text-sm text-muted-foreground">Preparing sign-in…</p>}
          {login.data && <>
            <a className="block break-all text-sm underline" href={login.data.url} target="_blank" rel="noreferrer">Open sign-in page ↗</a>
            {login.data.bridge !== "ok" && <p className="text-sm text-destructive">The callback bridge on your Mac is not running. Before finishing sign-in, run <code className="break-all rounded bg-muted px-1">ssh -L 1455:127.0.0.1:1455 devbox</code> in a terminal and keep it open.</p>}
            {!login.error && <p role="status" className="text-sm text-muted-foreground">Waiting for sign-in…</p>}
          </>}
          {login.error && <p role="alert" className="text-sm text-destructive">{login.error}</p>}
          <div className="flex justify-end"><Button variant="outline" onClick={login.close}>Close</Button></div>
        </div>
      </FormDialog>
    </div>
  );
}

/** Google OAuth without a browser on the server: the user opens the link, Google shows them
 *  an authorization code and it is pasted here (agy waits for it in the login container). */
function CodeLoginRow({ label, loginLabel, status, start, submitCode, pollStatus, onDone, onError, onLogout }: {
  label: string; loginLabel: string; status: AuthProvider;
  start: () => Promise<{ url: string }>; submitCode: (code: string) => Promise<void>;
  pollStatus: () => Promise<LoginPollStatus>; onDone: () => Promise<void>;
  onError: (msg: string) => void; onLogout: () => Promise<void>;
}) {
  const login = useLoginDialog(start, pollStatus, onDone, onError);
  const [code, setCode] = useState("");
  const [submit, setSubmit] = useState<CodeSubmitState>(CODE_SUBMIT_IDLE);
  const b = providerBadge(status);
  const reset = () => { setCode(""); setSubmit(CODE_SUBMIT_IDLE); };
  const close = () => { reset(); login.close(); };
  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = code.trim();
    if (!canSubmitCode(submit, trimmed)) return;
    setSubmit(codeSubmitStart());
    try {
      await submitCode(trimmed);
      setSubmit(codeSubmitSucceeded());
    } catch (err) {
      const message = (err as Error).message;
      setSubmit(codeSubmitFailed(message));
      onError(message);
    }
  }
  return (
    <div className="flex flex-wrap items-center gap-3 py-2">
      <span className="w-36 shrink-0 text-sm font-medium">{label}</span>
      <Badge variant={b.tone === "ok" ? "default" : "secondary"}>{b.text}</Badge>
      <span className="min-w-0 break-words text-sm text-muted-foreground">{status.detail}</span><span className="flex-1" />
      {!status.loggedIn && <Button size="sm" onClick={() => { reset(); void login.begin(); }}>{loginLabel}</Button>}
      {status.loggedIn && <ActionButton size="sm" variant="ghost" onError={onError} onAction={async () => { await onLogout(); await onDone(); }}>Log out</ActionButton>}
      <FormDialog open={login.open} onOpenChange={(next) => { if (!next) close(); }} title={loginLabel} description={`Connect ${label} with the Google account that has your subscription.`}>
        <div className="space-y-4">
          {!login.data && !login.error && <p role="status" className="text-sm text-muted-foreground">Preparing sign-in…</p>}
          {login.data && <>
            <p className="text-sm">1. <a className="underline" href={login.data.url} target="_blank" rel="noreferrer">Open Google sign-in ↗</a></p>
            <p className="text-sm">2. Paste the authorization code Google shows you:</p>
            <form className="flex gap-2" onSubmit={handleSubmit}>
              <input className="min-w-0 flex-1 rounded-md border bg-background px-3 py-2 font-mono text-sm" value={code} onChange={(e) => setCode(e.target.value)} disabled={submit.phase !== "idle"} autoComplete="off" spellCheck={false} aria-label="Authorization code" />
              <Button type="submit" size="sm" disabled={!canSubmitCode(submit, code)}>{submit.phase === "submitting" ? "Submitting…" : "Submit"}</Button>
            </form>
            {submit.phase === "sent" && !login.error && <p role="status" className="text-sm text-muted-foreground">Checking the code…</p>}
          </>}
          {submit.error && <p role="alert" className="text-sm text-destructive">{submit.error}</p>}
          {login.error && <p role="alert" className="text-sm text-destructive">{login.error}</p>}
          <p className="text-xs text-muted-foreground">Already running Antigravity sessions keep their previous sign-in until they restart.</p>
          <div className="flex justify-end"><Button variant="outline" onClick={close}>Close</Button></div>
        </div>
      </FormDialog>
    </div>
  );
}

const NOT_LOGGED_IN: AuthProvider = { loggedIn: false, detail: "…" };

/** Accounts for AI subs. One table, a row per account, the same controls for all — it used to
 *  be three cards with three different shapes and one had to guess why ChatGPT
 *  needs logging in twice.
 *
 *  ChatGPT is in the list twice ON PURPOSE: native Codex and the proxy each have their own
 *  login storage and the proxy cannot import foreign credentials (it only has an import for
 *  Vertex, verified in its flags). The "Proxy ·" prefix is the only thing that shows the difference
 *  at first glance — without it it looks like a duplicate or a bug. */
export function Accounts() {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function refresh() { try { setStatus(await api.auth()); } catch (e) { setErr((e as Error).message); } }
  useEffect(() => { refresh(); }, []);

  const claudeB = providerBadge(status?.claude ?? { loggedIn: false });

  return (
    <div className="flex flex-col gap-4">
      <Card><CardContent className="flex flex-col gap-2 p-4">
        {/* Claude has no action: it logs in outside the dashboard (account pool), only the status is here. */}
        <div className="flex flex-wrap items-center gap-3 border-b pb-3">
          <span className="w-40 shrink-0 text-sm font-medium">Claude</span>
          <Badge variant={claudeB.tone === "ok" ? "default" : "secondary"}>{claudeB.text}</Badge>
          <span className="text-sm text-muted-foreground">{status?.claude.detail ?? "…"}</span>
        </div>

        <DeviceLoginRow label="Codex CLI" loginLabel="Log in with ChatGPT" status={status?.codex ?? NOT_LOGGED_IN}
          start={api.codexLoginStart} pollStatus={api.codexLoginStatus} onDone={refresh} onError={setErr}
          onLogout={api.codexLogout} />

        <DeviceLoginRow label="Grok Build" loginLabel="Log in with Grok" status={status?.grok ?? NOT_LOGGED_IN}
          start={api.grokLoginStart} pollStatus={api.grokLoginStatus} onDone={refresh} onError={setErr} />

        {/* Older devd lacks `antigravity` in /api/auth — the button would end in a 404.
            Hidden until the state arrives with that field (see authView.showAgyRow). */}
        {showAgyRow(status) && (
          <CodeLoginRow label="Antigravity" loginLabel="Sign in with Google" status={status!.antigravity!}
            start={api.agyLoginStart} submitCode={api.agyLoginCode} pollStatus={api.agyLoginStatus}
            onDone={refresh} onError={setErr} onLogout={api.agyLogout} />
        )}

        <UrlLoginRow label="Proxy · ChatGPT" loginLabel="Log in with ChatGPT" status={status?.proxyCodex ?? NOT_LOGGED_IN}
          start={() => api.proxyLoginStart("codex")} pollStatus={() => api.proxyLoginStatus("codex")}
          onDone={refresh} onError={setErr} />

        <UrlLoginRow label="Proxy · xAI" loginLabel="Log in with xAI" status={status?.proxyXai ?? NOT_LOGGED_IN}
          start={() => api.proxyLoginStart("xai")} pollStatus={() => api.proxyLoginStatus("xai")}
          onDone={refresh} onError={setErr} />

        {/* Older devd lacks `proxyAntigravity` in /api/auth — the button would end in a 404,
            hidden until the state arrives (same pattern as showAgyRow above). */}
        {status?.proxyAntigravity && (
          <UrlLoginRow label="Proxy · Antigravity" loginLabel="Sign in with Google (for Claude Code + Gemini)" status={status.proxyAntigravity}
            start={() => api.proxyLoginStart("antigravity")} pollStatus={() => api.proxyLoginStatus("antigravity")}
            onDone={refresh} onError={setErr} />
        )}
      </CardContent></Card>

      {err && <p className="text-sm text-destructive">{err}</p>}
    </div>
  );
}

/* ============================== page ============================== */

export function Settings() {
  const { refresh: refreshStore } = useStore();
  const [draft, setDraft] = useState<DevConfig | null>(null);
  const [baseline, setBaseline] = useState("");
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [jsonOpen, setJsonOpen] = useState(false);
  const [jsonText, setJsonText] = useState("");
  const [giteaInfo, setGiteaInfo] = useState<GiteaInstanceInfo[]>([]);
  // Whole accounts, not just ids (I2, final review) — the banner needs to know whether
  // soloAccountId points to a HEALTHY account (exists, not disabled/quarantined),
  // not just whether the id exists in the pool at all.
  const [poolAccounts, setPoolAccounts] = useState<AccountView[]>([]);
  const [pinProject, setPinProject] = useState("");
  const [pinAccount, setPinAccount] = useState("");
  const [pinOpen, setPinOpen] = useState(false);
  const [instanceEdit, setInstanceEdit] = useState<number | "new" | null>(null);
  const [instanceName, setInstanceName] = useState("");
  const [instanceUrl, setInstanceUrl] = useState("");
  const [instanceError, setInstanceError] = useState<string | null>(null);

  useEffect(() => {
    // 503 = the pool is not configured in this devd; the section then just offers
    // no accounts, but it must not crash the whole settings page.
    api.accounts().then((r) => setPoolAccounts(r.accounts)).catch(() => setPoolAccounts([]));
  }, []);

  const poolAccountIds = poolAccounts.map((a) => a.id);
  const healthyPoolAccountIds = new Set(poolAccounts.filter((a) => !a.disabled && !a.quarantined).map((a) => a.id));

  async function load() {
    setLoadErr(null);
    try {
      const cfg = validateConfig(await api.config());
      setDraft(cloneConfig(cfg));
      setBaseline(JSON.stringify(cfg));
      setSaved(false);
      setJsonText((t) => (t ? JSON.stringify(cfg, null, 2) : t));
      api.giteaInstances().then((r) => setGiteaInfo(r.instances)).catch(() => setGiteaInfo([]));
    } catch (e) { setLoadErr((e as Error).message); }
  }
  useEffect(() => { load(); }, []);

  const dirty = useMemo(() => draft !== null && JSON.stringify(draft) !== baseline, [draft, baseline]);
  const issues = useMemo(() => (draft ? configIssues(draft) : []), [draft]);

  function mutate(next: DevConfig) { setDraft(next); setSaved(false); }
  function tryMutate(fn: () => DevConfig): string | null {
    try { mutate(fn()); return null; } catch (e) { return (e as Error).message; }
  }

  // Saves everything EXCEPT folders — those are owned by the Folders page. Without this a save
  // from Settings would revert folders that someone changed elsewhere in the meantime.
  async function save() {
    if (!draft || issues.length > 0) return;
    setSaveErr(null);
    const server = validateConfig(await api.config());
    const merged = validateConfig(mergeSettings(server, draft));
    await api.saveConfig(merged);
    setDraft(cloneConfig(merged));
    setBaseline(JSON.stringify(merged));
    setSaved(true);
    api.giteaInstances().then((r) => setGiteaInfo(r.instances)).catch(() => {});
  }

  const jsonError = useMemo(() => {
    if (!jsonOpen) return null;
    try { validateConfig(JSON.parse(jsonText)); return null; }
    catch (e) { return (e as Error).message; }
  }, [jsonOpen, jsonText]);

  return (
    <AppPage title="Settings" sub="Runtime settings, critic, accounts. Saving commits and pushes to the config repository.">
      {loadErr && (
        <div className="mb-4 flex flex-wrap items-center gap-2 text-sm font-medium text-destructive">
          <span>Failed to load configuration: {loadErr}</span>
          <Button variant="outline" size="sm" onClick={load}>Try again</Button>
        </div>
      )}

      <Section label="Runtime">
        <Card><CardContent className="grid gap-x-6 gap-y-5 p-4 sm:grid-cols-2 lg:grid-cols-4">
          {draft ? (
            <>
              <NumField label="Auto-stop" hint="hours of inactivity after which a session stops" unit="h" k="autoStopHours" value={draft.settings.autoStopHours} onChange={(k, v) => draft && mutate(updateSetting(draft, k, v))} />
              <NumField label="Port range start" hint="first port of the assigned range" unit="port" k="portRangeStart" value={draft.settings.portRangeStart} onChange={(k, v) => draft && mutate(updateSetting(draft, k, v))} />
              <NumField label="Ports per session" hint="how many ports each session gets" unit="ports" k="portsPerSession" value={draft.settings.portsPerSession} onChange={(k, v) => draft && mutate(updateSetting(draft, k, v))} />
              <SliderField label="Disk warning" hint="disk usage at which a warning fires" k="diskWarnPercent" value={draft.settings.diskWarnPercent} onChange={(k, v) => draft && mutate(updateSetting(draft, k, v))} />
            </>
          ) : [0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-[68px] rounded-md" />)}
        </CardContent></Card>
      </Section>

      <Section label="Critic">
        <Card><CardContent className="p-4">
          {draft ? (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <label className="flex flex-col gap-1 text-sm">Provider
                <Select value={getCritic(draft).provider} onValueChange={(v) => mutate(setCritic(draft, { provider: v as "claude" | "codex" | "antigravity" }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="claude">Claude</SelectItem>
                    <SelectItem value="codex">Codex / ChatGPT</SelectItem>
                    {/* Antigravity was hidden until the --mode plan + prompt-via-file contract
                        was verified live (see criticProvider.ts). Questions 7–11 (the "Critic" section)
                        confirmed it against a real logged-in account: --mode plan is read-only,
                        the untrusted-folder prompt does not hang and --model gemini-3.8-flash-medium works —
                        so the option is now permanently on offer. */}
                    <SelectItem value="antigravity">Antigravity</SelectItem>
                  </SelectContent>
                </Select>
              </label>
              <label className="flex flex-col gap-1 text-sm">Model
                {/* Models cannot be listed programmatically from the Claude, Codex or Antigravity CLI,
                    so it stays free text — the datalist at least offers the usual ones for
                    the selected provider (see criticModelSuggestions). */}
                <Input list="critic-models" value={getCritic(draft).model}
                  placeholder={getCritic(draft).provider === "claude" ? "opus" : "default"}
                  onChange={(e) => mutate(setCritic(draft, { model: e.target.value }))} />
                <datalist id="critic-models">
                  {criticModelSuggestions(getCritic(draft).provider).map((m) => <option key={m} value={m} />)}
                </datalist>
              </label>
              <label className="flex flex-col gap-1 text-sm">Rounds
                <Input type="number" value={getCritic(draft).rounds}
                  onChange={(e) => mutate(setCritic(draft, { rounds: Number(e.target.value) }))} />
              </label>
              <label className="flex flex-col gap-1 text-sm">Timeout (s)
                <Input type="number" value={getCritic(draft).timeoutSec}
                  onChange={(e) => mutate(setCritic(draft, { timeoutSec: Number(e.target.value) }))} />
              </label>
            </div>
          ) : <Skeleton className="h-[68px] rounded-md" />}
        </CardContent></Card>
      </Section>

      <Section label="Account pool">
        <Card><CardContent className="space-y-4 p-4">
          {draft ? (
            <>
              {getAccountPool(draft).soloAccountId !== null && (() => {
                const solo = getAccountPool(draft).soloAccountId!;
                // I2 (final review): the spec requires the banner to turn red when solo
                // mode points at a non-existent/disabled account — that state is WORSE than
                // a broken pin (it leaves EVERY session without an account), so amber
                // (ordinary, visible, but not alarming) is not enough.
                const broken = !healthyPoolAccountIds.has(solo);
                return (
                  <div className={cn("rounded-md border px-3 py-2 text-sm font-medium",
                    broken
                      ? "border-red-600/40 bg-red-500/10 text-red-700 dark:text-red-400"
                      : "border-amber-600/40 bg-amber-500/10 text-amber-700 dark:text-amber-400")}>
                    Single-account mode: {solo} — project pins are ignored.
                    {broken && " This account is missing or disabled — every session falls back to the shared profile."}
                  </div>
                );
              })()}
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <label className="flex flex-col gap-1 text-sm">Account selection
                  <Select value={getAccountPool(draft).preferredAccountId ?? "none"}
                    onValueChange={(v) => mutate(setAccountPool(draft, { preferredAccountId: v === "none" ? null : v }))}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">Automatic · current usage</SelectItem>
                      {poolAccountIds.map((id) => <SelectItem key={id} value={id}>{id}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </label>
                <label className="flex flex-col gap-1 text-sm">Single-account mode
                  <Select value={getAccountPool(draft).soloAccountId ?? "off"}
                    onValueChange={(v) => mutate(setAccountPool(draft, { soloAccountId: v === "off" ? null : v }))}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="off">Off</SelectItem>
                      {poolAccountIds.map((id) => <SelectItem key={id} value={id}>{id}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </label>
                <PercentSlider label="Spillover" hint="preferred account usage at which others join in"
                  min={1} max={100} value={getAccountPool(draft).spilloverPct}
                  onChange={(v) => mutate(setAccountPool(draft, { spilloverPct: v }))} />
                <PercentSlider label="Exhausted" hint="usage at which an account drops out of the pool"
                  min={1} max={100} value={getAccountPool(draft).thresholdPct}
                  onChange={(v) => mutate(setAccountPool(draft, { thresholdPct: v }))} />
              </div>

              <div className="space-y-2">
                <span className="text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">Project pins</span>
                {Object.entries(getAccountPool(draft).projectAccounts).sort(([a], [b]) => a.localeCompare(b)).map(([project, accountId]) => (
                  <div key={project} className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-mono">{project}</span>
                    <span className="text-muted-foreground">→</span>
                    <span className="font-mono">{accountId}</span>
                    {!poolAccountIds.includes(accountId) && (
                      <span className="text-xs font-medium text-destructive">unknown account</span>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => mutate(removeProjectPin(draft, project))}>Remove</Button>
                  </div>
                ))}
                <Button size="sm" variant="outline" onClick={() => setPinOpen(true)}>Add project pin</Button>
                <FormDialog open={pinOpen} onOpenChange={setPinOpen} title="Add project pin" description="Assign a project to an account. Apply this to the editor, then Save + push to activate it.">
                  <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (!pinProject.trim() || !pinAccount) return; mutate(setProjectPin(draft, pinProject.trim(), pinAccount)); setPinProject(""); setPinAccount(""); setPinOpen(false); }}>
                    <label className="grid gap-1.5 text-sm font-medium">Project<Input required value={pinProject} onChange={(e) => setPinProject(e.target.value)} /></label>
                    <label className="grid gap-1.5 text-sm font-medium">Account<select required className="h-11 rounded-md border bg-background px-3 text-sm" value={pinAccount} onChange={(e) => setPinAccount(e.target.value)}><option value="">Choose account</option>{poolAccountIds.map((id) => <option key={id} value={id}>{id}</option>)}</select></label>
                    <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => setPinOpen(false)}>Cancel</Button><Button type="submit" disabled={!pinProject.trim() || !pinAccount}>Apply to editor</Button></div>
                  </form>
                </FormDialog>
              </div>
            </>
          ) : <Skeleton className="h-[68px] rounded-md" />}
        </CardContent></Card>
      </Section>

      {/* Accounts moved to AI subs — they belong with the subscription limits, not among
          the devbox settings, and in two places they would drift apart. */}

      <Section label="Gitea instances" meta={draft?.giteaInstances?.length ? `${draft.giteaInstances.length}` : undefined}>
        <Card><CardContent className="flex flex-col gap-3 p-4">
          {draft && (draft.giteaInstances ?? []).map((g, i) => (
            <div className="flex flex-col gap-2.5 border-b border-dashed pb-3.5 last:border-b-0 last:pb-0" key={i}>
              <div className="grid gap-2.5 sm:grid-cols-[minmax(110px,190px)_minmax(0,1fr)_auto] sm:items-center">
                <div className="min-w-0"><p className="truncate text-sm font-medium">{g.name || "Unnamed instance"}</p><p className="truncate text-xs text-muted-foreground">{g.url || "No URL"}</p></div>
                <Button size="sm" variant="outline" className="sm:justify-self-end" onClick={() => { setInstanceEdit(i); setInstanceName(g.name); setInstanceUrl(g.url); setInstanceError(null); }}>Edit instance</Button>
                <ConfirmButton size="sm" variant="ghost" confirmLabel="Remove it?"
                  onConfirm={() => { tryMutate(() => removeGiteaInstance(draft, i)); }}>Remove</ConfirmButton>
              </div>
              <GiteaTokenControl name={g.name} info={giteaInfo.find((x) => x.name === g.name)}
                onSaved={() => api.giteaInstances().then((r) => setGiteaInfo(r.instances)).catch(() => {})} />
            </div>
          ))}
          {draft && (draft.giteaInstances ?? []).length === 0 && (
            <span className="text-xs text-muted-foreground">no Gitea instance — GitHub works fine without one</span>
          )}
          <div>
            <Button variant="outline" size="sm" disabled={!draft} onClick={() => { setInstanceEdit("new"); setInstanceName(""); setInstanceUrl(""); setInstanceError(null); }}>
              + Add instance
            </Button>
          </div>
        </CardContent></Card>
      </Section>

      <FormDialog open={instanceEdit !== null} onOpenChange={(next) => { if (!next) setInstanceEdit(null); }} title={instanceEdit === "new" ? "Add Gitea instance" : "Edit Gitea instance"} description="Apply these changes to the editor, then Save + push before adding a token.">
        <form className="space-y-4" onSubmit={(e) => {
          e.preventDefault(); if (!draft || instanceEdit === null) return;
          const base = instanceEdit === "new" ? addGiteaInstance(draft) : draft;
          const index = instanceEdit === "new" ? (base.giteaInstances?.length ?? 1) - 1 : instanceEdit;
          const next = updateGiteaInstance(base, index, { name: instanceName.trim(), url: instanceUrl.trim() });
          const problem = giteaIssues(next.giteaInstances)[0];
          if (problem) { setInstanceError(problem); return; }
          mutate(next); setInstanceEdit(null);
        }}>
          <label className="grid gap-1.5 text-sm font-medium">Instance name<Input required placeholder="main" value={instanceName} onChange={(e) => setInstanceName(e.target.value)} /></label>
          <label className="grid gap-1.5 text-sm font-medium">URL<Input type="url" required placeholder="https://git.example.com" value={instanceUrl} onChange={(e) => setInstanceUrl(e.target.value)} /></label>
          {instanceError && <p role="alert" className="text-sm text-destructive">{instanceError}</p>}
          <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => setInstanceEdit(null)}>Cancel</Button><Button type="submit">Apply to editor</Button></div>
        </form>
      </FormDialog>

      <Section label="Advanced">
        <Card><CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
          <p className="text-sm text-muted-foreground">Edit the configuration directly for settings outside these controls.</p>
          <Button variant="outline" disabled={!draft} onClick={() => { if (draft) setJsonText(JSON.stringify(draft, null, 2)); setJsonOpen(true); }}>Edit JSON</Button>
        </CardContent></Card>
        <FormDialog open={jsonOpen} onOpenChange={setJsonOpen} title="Configuration JSON" description="Apply valid JSON to the editor. Save + push commits your settings; folders are managed separately.">
          <div className="space-y-4">
            <textarea className="min-h-[320px] w-full resize-y rounded-md border bg-transparent p-3 font-mono text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring" value={jsonText} spellCheck={false} onChange={(e) => setJsonText(e.target.value)} aria-label="Configuration editor (JSON)" />
            {jsonError && <p role="alert" className="text-sm text-destructive">{jsonError}</p>}
            <div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => setJsonOpen(false)}>Cancel</Button><Button disabled={!!jsonError} onClick={() => { if (!jsonError) { const problem = tryMutate(() => cloneConfig(validateConfig(JSON.parse(jsonText)))); if (!problem) setJsonOpen(false); } }}>Apply to editor</Button></div>
          </div>
        </FormDialog>
      </Section>

      <Section label="Danger zone">
        <Card className="border-destructive/40"><CardContent className="flex flex-wrap items-center gap-3 p-4">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">Reset statistics</div>
            <div className="text-xs text-muted-foreground">
              Wipes cost, tokens, prompt metrics and commit counters. Sessions, disk history and the log stay.
            </div>
          </div>
          <ConfirmButton variant="outline" confirmLabel="Yes, wipe the stats"
            onConfirm={async () => { await api.resetStats(); await refreshStore(); }}>Reset stats</ConfirmButton>
        </CardContent></Card>
      </Section>

      <Card>
        <CardContent className="flex flex-wrap items-center gap-3 p-4">
          <ActionButton disabled={!draft || !dirty || issues.length > 0} onAction={save} onError={setSaveErr}>Save + push</ActionButton>
          <Button variant="outline" disabled={!draft} onClick={load}>Reload from server</Button>
          {issues.length > 0 && (
            <span className="text-xs font-medium text-destructive">{issues[0]}{issues.length > 1 ? ` (+ ${issues.length - 1} more)` : ""}</span>
          )}
          {issues.length === 0 && dirty && <span className="text-xs font-medium text-amber-600 dark:text-amber-400">● unsaved changes</span>}
          {saved && !dirty && <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400">Saved and pushed</span>}
          {saveErr && <span className="text-xs font-medium text-destructive">Error: {saveErr}</span>}
        </CardContent>
      </Card>
    </AppPage>
  );
}
