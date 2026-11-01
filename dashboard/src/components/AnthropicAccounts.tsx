import { Link } from "react-router-dom";
import { FormDialog } from "./FormDialog";
import { QuotaBar } from "./QuotaBar";
import { useEffect, useState } from "react";
import { api, ApiError, type AccountPoolView, type AccountView } from "../api";
import { ActionButton, ConfirmButton, Section, SecretInput } from "./primitives";
import { Gauge } from "./Gauge";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import {
  accountStatus, identityIssues, leaseSummary, measuredLabel, modelRows, pinnedProjects, poolRole,
  POOL_ROLE_LABEL, resetCountdown, splitTierLabel, usageErrorView, usageSeverity,
} from "../accountsView";

/* ============================== Anthropic accounts (pool) ============================== */

export function AnthropicAccounts() {
  const [accounts, setAccounts] = useState<AccountView[] | null>(null);
  // Pool settings from devd. `null` = not arrived yet; components then fall back to
  // their defaults instead of guessing (the threshold used to be hardwired to 90).
  const [pool, setPool] = useState<AccountPoolView | null>(null);
  const [poolOff, setPoolOff] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [newId, setNewId] = useState("");
  const [newCreds, setNewCreds] = useState("");
  // Credentials replacement: id of the expanded account + the blob being typed. The blob is a SECRET, so
  // it is cleared from state right after submitting and after closing the form (see GiteaTokenControl).
  const [replaceId, setReplaceId] = useState<string | null>(null);
  const [replaceCreds, setReplaceCreds] = useState("");
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [err, setErr] = useState<string | null>(null);
  // A notice that is NOT an error (removal succeeded, it just left cleanup behind).
  const [notice, setNotice] = useState<string | null>(null);

  // 503 = the account pool is not configured in this devd (older build, or deliberately
  // disabled). It is not an error to show in red, the whole section is just hidden.
  // setErr(null) on success is required — reload ticks every minute, otherwise a
  // one-off VPN outage would stay hanging as an error even after the connection recovers.
  async function refreshAccounts() {
    try { const r = await api.accounts(); setAccounts(r.accounts); setPool(r.pool); setPoolOff(false); setErr(null); }
    catch (e) { if (e instanceof ApiError && e.status === 503) setPoolOff(true); else setErr((e as Error).message); }
  }

  useEffect(() => {
    refreshAccounts();
    // Countdowns to reset are relative to "now" — without a tick they would freeze at load time.
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    const reload = setInterval(() => { refreshAccounts(); }, 60_000);
    return () => { clearInterval(tick); clearInterval(reload); };
  }, []);

  // Closing the form without submitting also clears the typed credentials — a secret has no
  // business staying in component state a second longer than necessary (see GiteaTokenControl).
  function closeAdd() { setAddOpen(false); setNewId(""); setNewCreds(""); }

  async function addAccount() {
    setErr(null); setBusy(true);
    try {
      await api.addAccount(newId.trim(), newCreds.trim(), newId.trim());
      setNewId(""); setAddOpen(false);
      await refreshAccounts();
    } catch (e) { setErr((e as Error).message); }
    // credentials always disappear from state — whether adding succeeded or not, the value has already
    // gone to the server and has nothing more to do in the browser.
    finally { setNewCreds(""); setBusy(false); }
  }

  // The error goes up via onError of ActionButton/ConfirmButton (see JSX) — it is left
  // to bubble up, not swallowed here, so the button itself can show "in progress"/"failed".
  async function toggleAccount(a: AccountView) {
    await api.setAccountDisabled(a.id, !a.disabled);
    await refreshAccounts();
  }

  // On a full devbox the usual result is `purged`: the account volume holds mounts of all
  // running sessions, so docker will not delete it. The account is gone and the token on disk
  // too, but an empty volume shell remains — without this message the operator would not
  // know about it and it would stay there forever.
  async function removeAccount(a: AccountView) {
    const r = await api.deleteAccount(a.id);
    setNotice(r.removal === "purged" && r.leftoverVolume
      ? `Account removed and its profile wiped, but the volume is still mounted by running sessions. After they are recreated, run: docker volume rm ${r.leftoverVolume}`
      : null);
    await refreshAccounts();
  }

  // Manual quota re-measurement. After an error the poller waits (backoff grows with the outage length), so
  // until then the card shows the last known numbers and the "Usage unavailable" badge — this
  // is the way to force a measurement now. The endpoint returns even a failed measurement as 200
  // (the error is in the data, not in the status), so the whole section is simply redrawn.
  async function refreshOne(a: AccountView) {
    await api.refreshAccount(a.id);
    await refreshAccounts();
  }

  function closeReplace() { setReplaceId(null); setReplaceCreds(""); }

  async function replaceCredentials(a: AccountView) {
    setErr(null); setBusy(true);
    try {
      await api.replaceAccountCredentials(a.id, replaceCreds.trim());
      setReplaceId(null);
      await refreshAccounts();
    } catch (e) { setErr((e as Error).message); }
    finally { setReplaceCreds(""); setBusy(false); }
  }

  if (poolOff) return null;

  // Over the WHOLE list: "two accounts point to the same organization" cannot be seen from one card.
  const issues = identityIssues(accounts ?? []);

  return (
    <Section label="Anthropic accounts" meta={
      <Button variant="outline" size="sm" onClick={() => (addOpen ? closeAdd() : setAddOpen(true))}>
        {addOpen ? "Cancel" : "Add Anthropic account"}
      </Button>
    }>
      {pool && <div className="mb-3 flex flex-wrap items-center gap-3">
        <Badge variant="secondary">{pool.soloAccountId ? "Single-account mode" : pool.preferredAccountId ? "Preferred account with spillover" : "Automatic selection"}</Badge>
        {!pool.soloAccountId && !pool.preferredAccountId && <span className="text-xs text-muted-foreground">Based on current usage{Object.keys(pool.projectAccounts).length > 0 ? " · project assignments apply" : ""}</span>}
        {(pool.soloAccountId || pool.preferredAccountId) && <Button variant="outline" size="sm" asChild><Link to="/settings">Selection settings</Link></Button>}
      </div>}
      <FormDialog open={addOpen} onOpenChange={(open) => { if (!open) closeAdd(); }} busy={busy} title="Add Anthropic account" description="Add a separate account to the automatic selection pool.">
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            On your Mac, log in to a throwaway profile and paste its credentials here:
          </p>
          <pre className="overflow-x-auto rounded-md border bg-muted px-3 py-2 text-xs">
{`profile_dir=$(mktemp -d)
CLAUDE_CONFIG_DIR="$profile_dir" claude auth login
pbcopy < "$profile_dir/.credentials.json"   # paste below, then delete the temp dir`}
          </pre>
          <p className="text-xs text-muted-foreground">
            This grant belongs to the devbox alone — the Mac gets its own login, so the two
            never rotate each other's refresh token.
          </p>
          <div className="grid gap-3">
            <Input aria-label="Account ID" placeholder="Account ID (A-Z, a-z, 0-9, -)" value={newId} onChange={(e) => setNewId(e.target.value)} className="w-full" />
            <SecretInput placeholder='{"claudeAiOauth":{…}}' value={newCreds}
              onChange={(e) => setNewCreds(e.target.value)} className="flex-1" aria-label="Account credentials JSON" />
            <Button size="sm" disabled={busy || !newId.trim() || !newCreds.trim()} onClick={addAccount}>
              {busy ? "Adding…" : "Add"}
            </Button>
          </div>
          {err && <p role="alert" className="text-sm text-destructive">{err}</p>}
        </div>
      </FormDialog>

      {accounts === null ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : accounts.length === 0 ? (
        <p className="text-sm text-muted-foreground">No accounts yet — sessions use the shared profile.</p>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {accounts.map((a) => {
            const st = accountStatus(a, pool?.thresholdPct);
            const issue = issues.get(a.id) ?? null;
            const models = modelRows({ ...a, limits: a.limits.filter((l) => l.kind === "weekly_scoped") });
            const { name, tier } = splitTierLabel(a.label);
            const role = pool ? poolRole(a, pool, now) : null;
            const pins = pool ? pinnedProjects(a.id, pool) : [];
            return (
              // `flex-1` + `mt-auto` on the button row: cards in the grid stretch to the height of the
              // taller one (the quota is supplemented by an identity warning, model list, running session),
              // so the shorter card had an empty strip BELOW the buttons and the pair looked
              // misaligned. `gap-3` instead of `space-y-3` deliberately — `space-y-*` is margin-top
              // on siblings and would override `mt-auto`.
              <Card key={a.id}><CardContent className="flex flex-1 flex-col gap-3 py-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-medium">{name}</span>
                      {tier && <Badge variant="outline" className="font-mono text-[10px]">{tier}</Badge>}
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                      <span className="font-mono">{a.id}</span>
                      {role && (
                        <span className={role === "backup" ? "" : "font-semibold text-foreground"}>
                          · {POOL_ROLE_LABEL[role]}
                        </span>
                      )}
                      {pins.length > 0 && (
                        <span className="font-semibold text-foreground">· PINNED: {pins.join(", ")}</span>
                      )}
                    </div>
                  </div>
                  {/* The measurement age belongs right under the badge, because it QUALIFIES it: the numbers
                      survive an error (the poller deliberately does not overwrite them with zeros), so
                      "Usage unavailable" by itself does not say how old the data is. */}
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <Badge variant={st.tone === "ok" ? "default" : st.tone === "danger" ? "destructive" : "secondary"}>{st.text}</Badge>
                    <span className="text-[11px] text-muted-foreground">{measuredLabel(a.fetchedAt, now)}</span>
                  </div>
                </div>

                {issue && (
                  <div className="rounded-md border border-destructive/50 bg-destructive/5 px-3 py-2">
                    <div className="text-xs font-semibold text-destructive">{issue.text}</div>
                    <div className="mt-0.5 text-xs text-muted-foreground">{issue.detail}</div>
                  </div>
                )}

                <QuotaBar percent={a.sevenDayPct} resetsAt={a.sevenDayResetsAt} now={now} />

                {models.length > 0 && (
                  <div className="space-y-1 text-xs">
                    {models.map((m) => (
                      <div key={m.model} className="flex justify-between">
                        <span className="text-muted-foreground">{m.model}</span>
                        <span className="font-mono tabular-nums">{m.percent === null ? "—" : `${Math.round(m.percent)}%`}</span>
                      </div>
                    ))}
                  </div>
                )}

                <div className="text-xs text-muted-foreground">Running: {leaseSummary(a)}</div>
                {(() => {
                  // Transient 429 = quiet gray sentence; a real outage = red
                  // with the verbatim error. usageErrorView decides, not the text length.
                  const ue = usageErrorView(a.error, a.errorCount);
                  if (!ue) return null;
                  return <div className={`text-xs ${ue.transient ? "text-muted-foreground" : "text-destructive"}`}>{ue.text}</div>;
                })()}
                {a.quarantined && (
                  <div className="text-xs text-destructive">
                    Log in again on your Mac and re-add this account.
                  </div>
                )}

                <div className="mt-auto flex flex-wrap gap-2">
                  <ActionButton size="sm" variant="outline" onError={setErr} onAction={() => refreshOne(a)}
                    title="Measure this account's quota now, ignoring the poller's backoff">
                    Refresh
                  </ActionButton>
                  <ActionButton size="sm" variant="ghost" onError={setErr} onAction={() => toggleAccount(a)}>
                    {a.disabled ? "Enable" : "Disable"}
                  </ActionButton>
                  <Button size="sm" variant="ghost"
                    onClick={() => (replaceId === a.id ? closeReplace() : (setReplaceCreds(""), setReplaceId(a.id)))}>
                    {replaceId === a.id ? "Cancel" : "Replace credentials"}
                  </Button>
                  <ConfirmButton size="sm" variant="ghost" confirmLabel="Remove it?" onError={setErr}
                    onConfirm={() => removeAccount(a)}>
                    Remove
                  </ConfirmButton>
                </div>

                <FormDialog open={replaceId === a.id} onOpenChange={(open) => { if (!open) closeReplace(); }} busy={busy} title={`Replace credentials · ${name}`} description="Update this account’s sign-in while preserving its profile.">
                  <div className="space-y-3">
                    <p className="text-xs text-muted-foreground">
                      Log in as the account this entry is supposed to be, then paste its credentials.
                      The profile is rewritten in place — sessions keep running.
                    </p>
                    {/* `claude auth login` opens a browser, and that one is signed in under the account
                        the operator normally uses it with — not the one that should come here.
                        This is exactly how a profile reporting a foreign organization came about (see identityIssues). */}
                    <p className="text-xs text-muted-foreground">
                      The login opens your browser and takes whichever account is already signed in
                      there — sign out of claude.ai first, or run it in a private window.
                    </p>
                    <pre className="overflow-x-auto rounded-md border bg-background px-2 py-1.5 text-[11px]">
{`profile_dir=$(mktemp -d)
CLAUDE_CONFIG_DIR="$profile_dir" claude auth login
pbcopy < "$profile_dir/.credentials.json"`}
                    </pre>
                    <div className="grid gap-3">
                      <SecretInput placeholder='{"claudeAiOauth":{…}}'
                        value={replaceCreds} onChange={(e) => setReplaceCreds(e.target.value)}
                        className="flex-1" aria-label={`New credentials for ${a.id}`} />
                      <Button size="sm" disabled={busy || !replaceCreds.trim()} onClick={() => replaceCredentials(a)}>
                        {busy ? "Saving…" : "Replace"}
                      </Button>
                    </div>
                    {err && <p role="alert" className="text-sm text-destructive">{err}</p>}
                  </div>
                </FormDialog>
              </CardContent></Card>
            );
          })}
        </div>
      )}

      {err && <p className="mt-3 text-sm text-destructive">{err}</p>}
      {notice && <p className="mt-3 text-sm text-muted-foreground">{notice}</p>}
    </Section>
  );
}

