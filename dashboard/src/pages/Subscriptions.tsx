import { FormDialog } from "../components/FormDialog";
import { QuotaBar } from "../components/QuotaBar";
import { WeeklyUsage } from "../components/WeeklyUsage";
import { useEffect, useState } from "react";
import { api } from "../api";
import { AnthropicAccounts } from "../components/AnthropicAccounts";
import { CodexAccounts } from "../components/CodexAccounts";
import { Accounts } from "./Settings";
import { ActionButton, AppPage, Section, SecretInput } from "../components/primitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Gauge } from "../components/Gauge";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { measuredLabel, resetCountdown, usageSeverity } from "../accountsView";
import { useNow } from "../store";
import {
  CODEX_CARD_LOADING, type CodexCardState, codexCardState, codexIssue, codexStatus, codexWindowLabel,
  GROK_CARD_LOADING, type GrokCardState, grokCardState, grokIssue, grokStatus,
} from "../subscriptionsView";
import { type OpenrouterView, openrouterStatus, saveLabel } from "../openrouterView";
import { formatTokens, parseTokens, sourceHint, type ProxyContextRow } from "../proxyContextView";

function CodexCard() {
  // One state object, not three independent useState calls — `codexCardState` (see
  // subscriptionsView.ts) is the single place that decides what stays after a poll
  // and what is forgotten. Previously `hidden` (404 on an older devd) lived outside this logic
  // and was cleared only in the success branch; a real error after a 404 thus stayed hidden
  // (#10 regression, fixed here).
  const [state, setState] = useState<CodexCardState>(CODEX_CARD_LOADING);
  // Countdowns to reset are relative to "now" — without a tick they would freeze at load time.
  const now = useNow(30_000);
  const { view: codex, hidden, fetchErr } = state;

  useEffect(() => {
    const load = () => api.codexSubscription()
      .then((r) => setState((prev) => codexCardState(prev, { ok: true, view: r.codex })))
      .catch((e) => setState((prev) => codexCardState(prev, { ok: false, error: e })));
    load();
    const reload = setInterval(load, 60_000);
    return () => clearInterval(reload);
  }, []);

  if (hidden) return null;
  if (fetchErr === null && codex === undefined) return <Skeleton className="h-56 w-full" />;
  // A devbox without the `codex-home` volume returns `codex: null` (not 404) — that is not an error,
  // the section simply is not rendered. Distinguished from the network/server error above (#10).
  if (fetchErr === null && codex === null) return null;

  const st = codex ? codexStatus(codex) : null;
  const issue = codex ? codexIssue(codex) : null;
  // The gauge is drawn ONLY for a measured number. Zero means "nothing used up", so
  // an empty gauge over "unknown" would claim the exact opposite of what we know.
  const measured = codex ? codex.windows.filter((w): w is typeof w & { usedPct: number } => w.usedPct !== null && w.windowMinutes === 10080) : [];

  return (
    <Section label="Codex">
      <Card><CardContent className="flex flex-col gap-3 py-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-medium">ChatGPT Codex</span>
              {codex?.planType && <Badge variant="outline" className="font-mono text-[10px]">{codex.planType}</Badge>}
            </div>
            <div className="mt-0.5 text-xs text-muted-foreground">codex-home</div>
          </div>
          {st && (
            <div className="flex shrink-0 flex-col items-end gap-1">
              <Badge variant={st.tone === "ok" ? "default" : st.tone === "danger" ? "destructive" : "secondary"}>{st.text}</Badge>
              <span className="text-[11px] text-muted-foreground">{measuredLabel(codex!.fetchedAt, now)}</span>
            </div>
          )}
        </div>

        {fetchErr && (
          <div className="rounded-md border border-destructive/50 bg-destructive/5 px-3 py-2">
            <div className="text-xs text-muted-foreground">Couldn't reach devd for the Codex quota: {fetchErr}</div>
          </div>
        )}

        {issue && (
          <div className="rounded-md border border-destructive/50 bg-destructive/5 px-3 py-2">
            <div className="text-xs text-muted-foreground">{issue}</div>
          </div>
        )}

        {measured.length > 0 && (
          <div className="space-y-2">{measured.map((w) => <QuotaBar key={w.kind} percent={w.usedPct} resetsAt={w.resetsAt} now={now} />)}</div>
        )}

        {codex?.credits && (
          <div className="flex justify-between text-xs">
            <span className="text-muted-foreground">Credits</span>
            <span className="font-mono tabular-nums">
              {codex.credits.unlimited ? "unlimited" : codex.credits.balance ?? "—"}
            </span>
          </div>
        )}
      </CardContent></Card>
    </Section>
  );
}

// Same skeleton as CodexCard above, with one difference in the body: xAI does not expose
// a percentage for SuperGrok (usedPct: null) and the gauge is drawn ONLY for a measured number —
// so null gets a dash with a countdown to reset, not an empty (falsely zero) gauge.
// Once the API starts filling in the percentage, the gauge lights up on its own.
function GrokCard() {
  const [state, setState] = useState<GrokCardState>(GROK_CARD_LOADING);
  const now = useNow(30_000);
  const { view: grok, hidden, fetchErr } = state;

  useEffect(() => {
    const load = () => api.grokSubscription()
      .then((r) => setState((prev) => grokCardState(prev, { ok: true, view: r.grok })))
      .catch((e) => setState((prev) => grokCardState(prev, { ok: false, error: e })));
    load();
    const reload = setInterval(load, 60_000);
    return () => clearInterval(reload);
  }, []);

  if (hidden) return null;
  if (fetchErr === null && grok === undefined) return <Skeleton className="h-40 w-full" />;
  // An older devd with the route but without the poller (no DB row yet) returns `grok: null` —
  // the section is not rendered, same convention as CodexCard.
  if (fetchErr === null && grok === null) return null;

  const st = grok ? grokStatus(grok) : null;
  const issue = grok ? grokIssue(grok) : null;

  return (
    <Section label="Grok">
      <Card><CardContent className="flex flex-col gap-3 py-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-medium">Grok</span>
              {grok?.tier && <Badge variant="outline" className="font-mono text-[10px]">{grok.tier}</Badge>}
            </div>
            <div className="mt-0.5 text-xs text-muted-foreground">grok-home</div>
          </div>
          {st && (
            <div className="flex shrink-0 flex-col items-end gap-1">
              <Badge variant={st.tone === "ok" ? "default" : st.tone === "danger" ? "destructive" : "secondary"}>{st.text}</Badge>
              <span className="text-[11px] text-muted-foreground">{measuredLabel(grok!.fetchedAt, now)}</span>
            </div>
          )}
        </div>

        {fetchErr && (
          <div className="rounded-md border border-destructive/50 bg-destructive/5 px-3 py-2">
            <div className="text-xs text-muted-foreground">Couldn't reach devd for the Grok quota: {fetchErr}</div>
          </div>
        )}

        {issue && (
          <div className="rounded-md border border-destructive/50 bg-destructive/5 px-3 py-2">
            <div className="text-xs text-muted-foreground">{issue}</div>
          </div>
        )}

        <p className="text-xs text-muted-foreground">Verified weekly allowances appear in the account overview above. This connection also supports plans without a reported weekly percentage.</p>

        <a href="https://grok.com" target="_blank" rel="noreferrer"
           className="text-xs text-muted-foreground underline hover:text-foreground">
          grok.com →
        </a>
      </CardContent></Card>
    </Section>
  );
}

// OpenRouter is not a subscription, but it belongs here for the same reason as the rest of the page:
// it answers the question "what can I run an agent on". Unlike the cards above it,
// nothing can be measured here — OpenRouter bills per request, no window gets used up —
// so instead of gauges the card carries what is variable here: the key and the model name.
function OpenrouterCard() {
  const [editing, setEditing] = useState(false);
  const [view, setView] = useState<OpenrouterView | null>(null);
  const [key, setKey] = useState("");
  const [model, setModel] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // 503 = an older devd without this route. The card is then not rendered at all, instead of
  // showing "Not connected" over something that cannot be connected from the dashboard.
  const [absent, setAbsent] = useState(false);

  const load = () => api.openrouter()
    .then((r) => { setView(r); setModel(r.model ?? ""); })
    .catch(() => setAbsent(true));
  useEffect(() => { load(); }, []);

  if (absent) return null;
  const st = openrouterStatus(view);

  return (
    <Section label="OpenRouter">
      <Card><CardContent className="flex flex-col gap-3 py-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <span className="font-medium">OpenRouter</span>
            <div className="mt-0.5 text-xs text-muted-foreground">Claude Code + OpenRouter profile</div>
          </div>
          <Badge variant={st.tone === "ok" ? "default" : "secondary"}>{st.text}</Badge>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3"><span className="text-sm text-muted-foreground">{view?.model ?? "No model configured"}</span><Button variant="outline" onClick={() => setEditing(true)}>Configure</Button></div>
        <FormDialog open={editing} onOpenChange={(open) => { setEditing(open); if (!open) setKey(""); }} title="Configure OpenRouter" description="Manage the API key and model used by this profile.">
          <div className="space-y-5">
        <div className="grid gap-3">
          <SecretInput className="h-11 w-full" placeholder="sk-or-v1-…"
            value={key} onChange={(e) => setKey(e.target.value)} aria-label="OpenRouter API key" />
          <ActionButton size="sm" onError={(m) => setMsg({ ok: false, text: m })}
            onAction={async () => {
              await api.openrouterSetKey(key.trim());
              setMsg({ ok: true, text: key.trim() ? "key saved" : "disconnected" });
              setKey(""); await load();
            }}>{saveLabel(view?.hasKey ?? false, key)}</ActionButton>
          <span className="text-[10.5px] text-muted-foreground">openrouter.ai → Keys</span>
        </div>

        <div className="grid gap-3">
          <Input className="h-11 w-full font-mono text-xs" placeholder="stealth/ox-alpha"
            value={model} onChange={(e) => setModel(e.target.value)} aria-label="OpenRouter model slug" />
          <ActionButton size="sm" disabled={!model.trim() || model.trim() === view?.model}
            onError={(m) => setMsg({ ok: false, text: m })}
            onAction={async () => {
              await api.openrouterSetModel(model.trim());
              setMsg({ ok: true, text: "model saved" });
              await load();
            }}>Save model</ActionButton>
          <span className="text-[10.5px] text-muted-foreground">
            Model slug as OpenRouter spells it. Takes effect the next time a session opens.
          </span>
        </div>
          {msg && <p role="status" className={msg.ok ? "text-sm text-muted-foreground" : "text-sm text-destructive"}>{msg.text}</p>}
          </div>
        </FormDialog>

        {/* Not a warning, just a fact you would not otherwise learn from the devbox: under this profile
            the repo contents go to a third party that, according to OpenRouter, retains them. */}
        <p className="text-[11px] text-muted-foreground">
          Sessions on this profile send your code to the model's provider. Stealth models retain
          prompts and completions — check the model's page before pointing private repos at it.
        </p>

        {msg && (
          <span className={msg.ok ? "text-xs font-medium text-emerald-600 dark:text-emerald-400"
                                  : "text-xs font-medium text-destructive"}>{msg.text}</span>
        )}
      </CardContent></Card>
    </Section>
  );
}

// One row = one proxy profile. The input is controlled only while editing (draft),
// otherwise it shows the saved override; Save is offered only for a valid number different
// from the saved one. "Auto" deletes the override — back to the catalog/1M default.
function ContextWindowRow({ row, onSaved, onError }: { row: ProxyContextRow; onSaved: () => Promise<void>; onError: (m: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? (row.override !== null ? String(row.override) : "");
  const parsed = parseTokens(value);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="w-44 shrink-0 text-xs">{row.label}</span>
      <Input className="h-8 w-32 font-mono text-xs" placeholder="auto"
        value={value} onChange={(e) => setDraft(e.target.value)} aria-label={`${row.label} context window`} />
      <ActionButton size="sm" disabled={parsed === null || parsed === row.override} onError={onError}
        onAction={async () => {
          await api.proxyContextSet(row.key, parsed!);
          setDraft(null); await onSaved();
        }}>Save</ActionButton>
      {row.override !== null && (
        <ActionButton size="sm" variant="ghost" onError={onError}
          onAction={async () => {
            await api.proxyContextSet(row.key, null);
            setDraft(null); await onSaved();
          }}>Auto</ActionButton>
      )}
      <span className="text-[10.5px] text-muted-foreground">
        {formatTokens(row.effective)} · {sourceHint(row)}
      </span>
    </div>
  );
}

function ContextWindowsCard() {
  const [rows, setRows] = useState<ProxyContextRow[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  // An older devd without the route → the section is not rendered (same pattern as OpenrouterCard).
  const [absent, setAbsent] = useState(false);

  const load = () => api.proxyContext()
    .then((r) => setRows(r.profiles))
    .catch(() => setAbsent(true));
  useEffect(() => { load(); }, []);

  if (absent || rows === null) return null;

  return (
    <Section label="Model context windows">
      <Card><CardContent className="flex flex-col gap-3 py-4">
        <p className="text-xs text-muted-foreground">
          Claude Code assumes a 200k window for models it doesn't recognize and compacts constantly.
          Values accept shorthand like <span className="font-mono">400k</span> or <span className="font-mono">1M</span>;
          they apply the next time a session opens. Setting a window larger than the model's real one
          trades compaction for API errors near the limit.
        </p>
        {rows.map((row) => (
          <ContextWindowRow key={row.key} row={row}
            onSaved={async () => { setMsg("saved"); await load(); }}
            onError={(m) => setMsg(m)} />
        ))}
        {msg && (
          <span className={msg === "saved" ? "text-xs font-medium text-emerald-600 dark:text-emerald-400"
                                           : "text-xs font-medium text-destructive"}>{msg}</span>
        )}
      </CardContent></Card>
    </Section>
  );
}

export function Subscriptions() {
  return (
    <AppPage title="AI limits & accounts" sub="Weekly usage across your accounts, with sign-in and automatic account selection in one place.">
      <WeeklyUsage />
      <h2 className="mb-5 text-lg font-semibold">Manage accounts</h2>
      <AnthropicAccounts />
      <CodexAccounts fallback={<CodexCard />} />
      <GrokCard />
      <OpenrouterCard />
      <details className="mb-6 rounded-lg border p-4"><summary className="cursor-pointer text-sm font-medium">Advanced model settings</summary><div className="mt-5"><ContextWindowsCard /></div></details>
      {/* Login belongs with the limits: "how much is left" and "what am I logged in with" are the same
          question from both sides. At the bottom on purpose — you read limits daily, log in rarely. */}
      <Section label="Service connections">
        <Accounts />
      </Section>
    </AppPage>
  );
}
