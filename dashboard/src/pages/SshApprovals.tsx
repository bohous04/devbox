import { KeyRound, ShieldCheck, Clock3, History, Check, X, Ban } from "lucide-react";
import { useEffect, useId, useMemo, useState, type FormEvent } from "react";
import { api, type SshApproval, type SshKey } from "../api";
import { AppPage, ActionButton, ConfirmButton, EmptyState, Section, StatusDot } from "../components/primitives";
import { FormDialog } from "../components/FormDialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { agoLabel } from "../format";
import { useNow } from "../store";
import { actionErrorMessage, GRANT_MINUTE_PRESETS, maxGrantMinutes, parseGrantMinutes, sshTargetLabel } from "../sshApprovalsView";
import {
  addSshServer, cloneConfig, mergeSshServers, removeSshServer, sshServerIssues, updateSshServer,
  validateConfig, type DevConfig, type SshServer,
} from "../configEdit";

const DOT_KIND: Record<SshApproval["status"], string> = {
  pending: "waiting", approved: "waiting", activated: "ok", denied: "danger", expired: "idle", revoked: "idle",
};
const STATUS_TONE: Record<SshApproval["status"], string> = {
  pending: "text-amber-600 dark:text-amber-400",
  approved: "text-amber-600 dark:text-amber-400",
  activated: "text-emerald-600 dark:text-emerald-400",
  denied: "text-red-600 dark:text-red-400",
  expired: "text-muted-foreground",
  // A revoked grant is a state the operator asked for (see revokeGrant) — not
  // an alarming result. The same muted display as for `expired`.
  revoked: "text-muted-foreground",
};

// Tri-state on purpose: `false` (disabled) is safe, true information about a disabled gate,
// whereas "we don't know" (unknown — the gate fetch failed, the rest may have loaded) is NOT the same as
// "enabled". If default/failure fell back to `enabled`, a persistent outage of just
// /api/ssh-gate (version skew during a rolling devd restart, an isolated route error) would hide the banner
// forever — a false reassurance about a security control, worse than a needless warning.
type GateState = "enabled" | "disabled" | "unknown";

function ApprovalActions({ id, busy, act }: {
  id: string;
  busy: boolean;
  act: (id: string, fn: () => Promise<unknown>) => Promise<void>;
}) {
  const durationId = useId();
  const minutesId = useId();
  const [duration, setDuration] = useState("60");
  const [customMinutes, setCustomMinutes] = useState("60");
  const permanent = duration === "permanent";
  const minutes = permanent ? null : parseGrantMinutes(duration === "custom" ? customMinutes : duration);
  const invalid = duration === "custom" && minutes === null;

  return (
    <div className="mt-4 space-y-3 border-t pt-4">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={durationId} className="text-xs text-muted-foreground">Access duration</label>
        <select id={durationId} value={duration} disabled={busy} onChange={(e) => setDuration(e.target.value)}
          className="h-11 rounded-md border border-input bg-background px-2 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50">
          {GRANT_MINUTE_PRESETS.map((value) => <option key={value} value={value}>{value} min</option>)}
          <option value="custom">Custom duration</option>
          <option value="permanent">Permanent</option>
        </select>
        {duration === "custom" && (
          <>
            <label htmlFor={minutesId} className="sr-only">Minutes</label>
            <Input id={minutesId} className="h-11 w-32" type="number" min={1} max={maxGrantMinutes()} step={1}
              inputMode="numeric" value={customMinutes} disabled={busy} onChange={(e) => setCustomMinutes(e.target.value)}
              aria-invalid={invalid} aria-describedby={invalid ? `${minutesId}-error` : undefined} />
            <span className="text-xs text-muted-foreground">min</span>
          </>
        )}
      </div>
      {invalid && <div id={`${minutesId}-error`} className="text-xs text-destructive">Enter a positive whole number of minutes.</div>}
      <div className="flex flex-wrap gap-2">
        <Button className="min-h-11" size="sm" disabled={busy} onClick={() => act(id, () => api.sshApprove(id))}><Check className="size-4" aria-hidden="true" />Allow once</Button>
        <Button className="min-h-11" variant="outline" size="sm" disabled={busy || (!permanent && minutes === null)} onClick={() => {
          if (permanent) void act(id, () => api.sshApprove(id, 0, true));
          else if (minutes !== null) void act(id, () => api.sshApprove(id, minutes));
        }}><Clock3 className="size-4" aria-hidden="true" />{permanent ? "Allow permanently" : minutes === null ? "Allow for selected duration" : `Allow for ${minutes} min`}</Button>
        <Button className="min-h-11 text-destructive" variant="ghost" size="sm" disabled={busy} onClick={() => act(id, () => api.sshDeny(id))}><X className="size-4" aria-hidden="true" />Deny</Button>
      </div>
    </div>
  );
}

type ServerForm = { name: string; key: string; user: string; host: string; port: string; note: string };
const EMPTY_SERVER_FORM: ServerForm = { name: "", key: "", user: "", host: "", port: "22", note: "" };

/** Manages `sshServers` in the config (see configEdit.ts) — aliases for servers against
 *  which `target`/`server` of requests and grants above on the page are resolved. It owns
 *  ONLY this config key (mergeSshServers), so a concurrent save from the
 *  Settings page (settings/giteaInstances) or Folders (folders) overwrites nothing. */
function ServerConfigSection() {
  const [draft, setDraft] = useState<DevConfig | null>(null);
  const [baseline, setBaseline] = useState("");
  const [opKeys, setOpKeys] = useState<SshKey[]>([]);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [edit, setEdit] = useState<number | "new" | null>(null);
  const [form, setForm] = useState<ServerForm>(EMPTY_SERVER_FORM);
  const [formErr, setFormErr] = useState<string | null>(null);

  async function load() {
    setLoadErr(null);
    try {
      const cfg = validateConfig(await api.config());
      setDraft(cloneConfig(cfg));
      setBaseline(JSON.stringify(cfg));
      setSaved(false);
    } catch (e) { setLoadErr((e as Error).message); }
    api.sshKeys().then((r) => setOpKeys(r.keys)).catch(() => setOpKeys([]));
  }
  useEffect(() => { load(); }, []);

  const dirty = useMemo(() => draft !== null && JSON.stringify(draft) !== baseline, [draft, baseline]);
  const issues = useMemo(() => (draft ? sshServerIssues(draft.sshServers) : []), [draft]);

  function mutate(next: DevConfig) { setDraft(next); setSaved(false); }

  async function save() {
    if (!draft || issues.length > 0) return;
    setSaveErr(null);
    const server = validateConfig(await api.config());
    const merged = validateConfig(mergeSshServers(server, draft));
    await api.saveConfig(merged);
    setDraft(cloneConfig(merged));
    setBaseline(JSON.stringify(merged));
    setSaved(true);
  }

  function openNew() {
    setEdit("new");
    setForm({ ...EMPTY_SERVER_FORM, key: opKeys[0]?.title ?? "" });
    setFormErr(null);
  }
  function openEdit(index: number, s: SshServer) {
    setEdit(index);
    setForm({ name: s.name, key: s.key, user: s.user, host: s.host, port: String(s.port), note: s.note ?? "" });
    setFormErr(null);
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!draft || edit === null) return;
    const base = edit === "new" ? addSshServer(draft) : draft;
    const index = edit === "new" ? (base.sshServers?.length ?? 1) - 1 : edit;
    const next = updateSshServer(base, index, {
      name: form.name.trim(), key: form.key.trim(), user: form.user.trim(), host: form.host.trim(),
      port: Number(form.port), note: form.note.trim() || undefined,
    });
    const problem = sshServerIssues(next.sshServers)[0];
    if (problem) { setFormErr(problem); return; }
    mutate(next);
    setEdit(null);
  }

  return (
    <>
      <Section label="Servers" meta={draft?.sshServers?.length ? `${draft.sshServers.length}` : undefined}>
        <Card><CardContent className="flex flex-col gap-3 p-4">
          {draft && (draft.sshServers ?? []).map((s, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2.5 border-b border-dashed pb-3.5 last:border-b-0 last:pb-0">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{s.name || "Unnamed server"}</p>
                <p className="truncate text-xs text-muted-foreground">{s.key || "no key"} · {s.user}@{s.host}:{s.port}{s.note ? ` · ${s.note}` : ""}</p>
              </div>
              <Button size="sm" variant="outline" onClick={() => openEdit(i, s)}>Edit</Button>
              <ConfirmButton size="sm" variant="ghost" confirmLabel="Remove it?" onConfirm={() => mutate(removeSshServer(draft, i))}>Remove</ConfirmButton>
            </div>
          ))}
          {draft && (draft.sshServers ?? []).length === 0 && (
            <span className="text-xs text-muted-foreground">No SSH servers configured — requests will show the raw target instead of an alias.</span>
          )}
          <div><Button variant="outline" size="sm" disabled={!draft} onClick={openNew}>+ Add server</Button></div>
        </CardContent></Card>
      </Section>

      <FormDialog open={edit !== null} onOpenChange={(next) => { if (!next) setEdit(null); }}
        title={edit === "new" ? "Add SSH server" : "Edit SSH server"}
        description="Apply this to the editor, then Save servers.">
        <form className="space-y-4" onSubmit={submit}>
          <label className="grid gap-1.5 text-sm font-medium">Name<Input required placeholder="shop-root" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} /></label>
          <label className="grid gap-1.5 text-sm font-medium">1Password key
            <select required className="h-11 rounded-md border bg-background px-3 text-sm" value={form.key} onChange={(e) => setForm((f) => ({ ...f, key: e.target.value }))}>
              <option value="">Choose key</option>
              {opKeys.map((k) => <option key={k.title} value={k.title}>{k.title}</option>)}
            </select>
          </label>
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="grid gap-1.5 text-sm font-medium">User<Input required value={form.user} onChange={(e) => setForm((f) => ({ ...f, user: e.target.value }))} /></label>
            <label className="grid gap-1.5 text-sm font-medium">Host<Input required value={form.host} onChange={(e) => setForm((f) => ({ ...f, host: e.target.value }))} /></label>
            <label className="grid gap-1.5 text-sm font-medium">Port<Input required type="number" min={1} max={65535} value={form.port} onChange={(e) => setForm((f) => ({ ...f, port: e.target.value }))} /></label>
          </div>
          <label className="grid gap-1.5 text-sm font-medium">Note (optional)<Input value={form.note} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} /></label>
          {formErr && <p role="alert" className="text-sm text-destructive">{formErr}</p>}
          <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => setEdit(null)}>Cancel</Button><Button type="submit">Apply to editor</Button></div>
        </form>
      </FormDialog>

      <Card>
        <CardContent className="flex flex-wrap items-center gap-3 p-4">
          <ActionButton disabled={!draft || !dirty || issues.length > 0} onAction={save} onError={setSaveErr}>Save servers</ActionButton>
          <Button variant="outline" disabled={!draft} onClick={load}>Reload</Button>
          {issues.length > 0 && (
            <span className="text-xs font-medium text-destructive">{issues[0]}{issues.length > 1 ? ` (+ ${issues.length - 1} more)` : ""}</span>
          )}
          {issues.length === 0 && dirty && <span className="text-xs font-medium text-amber-600 dark:text-amber-400">● unsaved changes</span>}
          {saved && !dirty && <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400">Saved</span>}
          {saveErr && <span className="text-xs font-medium text-destructive">Error: {saveErr}</span>}
          {loadErr && <span className="text-xs font-medium text-destructive">Failed to load configuration: {loadErr}</span>}
        </CardContent>
      </Card>
    </>
  );
}

export function SshApprovals() {
  const [rows, setRows] = useState<SshApproval[] | null>(null);
  const [grants, setGrants] = useState<SshApproval[]>([]);
  const [gate, setGate] = useState<GateState>("unknown");
  const [err, setErr] = useState<string | null>(null);
  // Action error (approve/reject/revoke grant), SEPARATE from `err` (the error of
  // `load()` — rows/grants/gate). `load()`'s `finally` in `act()` below runs after
  // EVERY action and overwrites `err`, so sharing one state would erase the action error in the
  // same tick before the user had a chance to see it — a 423 from
  // a locked vault would then look like a dead button with no explanation
  // (review finding). The same separated pattern as `actionError` on iOS
  // (SshApprovalsScreen.performAction).
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const now = useNow(1000);

  // allSettled, not sequential awaits in one try/catch: if one call fails, the rest
  // are still reflected — otherwise a temporary outage of one source would obscure the others that
  // arrived fine. The gate fetch is NOT in `failed` below — its failure goes to `gate: "unknown"`
  // (banner), not to `err` (that would show under "Awaiting approval" as "Error: …",
  // even though rows/grants were fine).
  async function load() {
    const [rowsR, grantsR, gateR] = await Promise.allSettled([api.sshApprovals(), api.sshGrants(), api.sshGate()]);
    if (rowsR.status === "fulfilled") setRows(rowsR.value);
    if (grantsR.status === "fulfilled") setGrants(grantsR.value);
    setGate(gateR.status === "fulfilled" ? (gateR.value.enabled ? "enabled" : "disabled") : "unknown");
    const failed = [rowsR, grantsR].find((r): r is PromiseRejectedResult => r.status === "rejected");
    setErr(failed ? (failed.reason as Error).message : null);
  }
  // One second, not five: the request lives 90 s and the countdown must be truthful.
  useEffect(() => { load(); const t = setInterval(load, 1000); return () => clearInterval(t); }, []);

  async function act(id: string, fn: () => Promise<unknown>) {
    setBusy(id);
    setActionErr(null);
    try {
      await fn();
    } catch (e) {
      // 409 = the Mac dialog or the phone won first — a normal lost race,
      // not an error. The refresh below (finally) immediately shows who won.
      setActionErr(actionErrorMessage(e));
    } finally {
      await load();
      setBusy(null);
    }
  }

  const pending = (rows ?? []).filter((r) => r.status === "pending");
  const past = (rows ?? []).filter((r) => r.status !== "pending");

  return (
    <AppPage title="SSH keys" sub="Review key requests and manage active access.">
      {gate === "disabled" && (
        <div className="mb-4 rounded-md border border-destructive bg-destructive/10 p-3 text-sm font-medium text-destructive">
          SSH approval is disabled. Keys are released without review.
        </div>
      )}
      {gate === "unknown" && (
        <div className="mb-4 rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm font-medium text-amber-600 dark:text-amber-400">
          SSH approval status is unavailable. Protection could not be verified.
        </div>
      )}
      <div className="mb-7 grid gap-3 sm:grid-cols-3">{[
        {label:"Requests",count:pending.length,icon:Clock3,tone:"bg-amber-500/10 text-amber-600"},
        {label:"Active grants",count:grants.length,icon:ShieldCheck,tone:"bg-emerald-500/10 text-emerald-600"},
        {label:"Recent decisions",count:past.length,icon:History,tone:"bg-blue-500/10 text-blue-600"}
      ].map(c=><div key={c.label} className="flex items-center gap-3 rounded-xl border p-4"><span className={`flex size-10 items-center justify-center rounded-xl ${c.tone}`}><c.icon className="size-5" aria-hidden="true" /></span><div><div className="text-2xl font-semibold tabular-nums">{rows ? c.count : "..."}</div><div className="text-xs text-muted-foreground">{c.label}</div></div></div>)}</div>
      <Section label="Awaiting approval" meta={rows ? `${pending.length}` : "Loading..."}>
        {err && <div className="mb-3 text-xs font-medium text-destructive">Error: {err}</div>}
        {actionErr && <div className="mb-3 text-xs font-medium text-destructive">{actionErr}</div>}
        {rows && pending.length === 0 && (
          <EmptyState title="All clear" hint="New key requests will appear here." />
        )}
        <div className="space-y-3">
          {pending.map((r) => (
            <Card key={r.id} className="overflow-hidden shadow-none">
              <CardContent className="p-5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-amber-500/10 text-amber-600"><KeyRound className="size-5" aria-hidden="true" /></span>
                  <span className="min-w-0 flex-1 text-base font-semibold">{r.title}</span>
                  <Badge variant="outline" className={cn("font-medium", STATUS_TONE[r.status])}>
                    {Math.max(0, Math.ceil((r.expires_at - now) / 1000))} s
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {r.project && r.repo ? `${r.project}/${r.repo}` : r.session_id ?? ""}
                  </span>
                </div>
                {/* target is the agent's claim (nothing verifies it), just like why/cwd — so it belongs
                    in the same box, not among the verified facts in the header above. */}
                <div className="mt-4 space-y-2 rounded-lg bg-muted/40 p-4 text-sm">
                  <div className="mb-2 text-xs font-medium text-muted-foreground">Agent-provided details</div>
                  <div>Target: {sshTargetLabel(r)}</div>
                  <div>{r.why}</div>
                  {r.cwd && <div className="mt-2 break-all font-mono text-xs text-muted-foreground">{r.cwd}</div>}
                </div>
                <ApprovalActions id={r.id} busy={busy === r.id} act={act} />
              </CardContent>
            </Card>
          ))}
        </div>
      </Section>

      {grants.length > 0 && (
        <Section label="Active access" meta={`${grants.length}`}>
          <div className="space-y-3">
            {grants.map((g) => (
              <Card key={g.id} className="border-emerald-500/20 shadow-none">
                <CardContent className="flex flex-wrap items-center gap-2 p-4">
                  <ShieldCheck className="size-5 shrink-0 text-emerald-600" aria-hidden="true" /><span className="text-sm font-semibold">{g.title}</span>
                  <span className="text-xs text-muted-foreground">{g.project && g.repo ? `${g.project}/${g.repo}` : g.session_id ?? ""}</span>
                  <span className="text-xs text-muted-foreground">{sshTargetLabel(g)}</span>
                  <span className="text-xs text-muted-foreground">{g.grant_permanent ? "Permanent" : `${Math.max(0, Math.ceil(((g.grant_until ?? 0) - now) / 60000))} min remaining`}</span>
                  <Button variant="outline" size="sm" className="ml-auto min-h-11 text-destructive" disabled={busy === g.id}
                    onClick={() => act(g.id, () => api.sshRevokeGrant(g.id))}><Ban className="size-4" aria-hidden="true" />Revoke</Button>
                </CardContent>
              </Card>
            ))}
          </div>
        </Section>
      )}

      {past.length > 0 && (
        <Section label="Recent history" meta={`${past.length}`}>
          <div className="space-y-3">
            {past.map((r) => (
              <Card key={r.id} className="overflow-hidden shadow-none">
                <CardContent className="p-5">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusDot kind={DOT_KIND[r.status]} />
                    <span className="text-sm font-semibold">{r.title}</span>
                    <Badge variant="outline" className={cn("font-medium", STATUS_TONE[r.status])}>{r.status}</Badge>
                    {r.decided_by && <span className="text-xs text-muted-foreground">via {r.decided_by}</span>}
                    <span className="ml-auto text-xs text-muted-foreground">{agoLabel(now - r.created_at)}</span>
                  </div>
                  <div className="mt-2 text-xs text-muted-foreground">{r.why}</div>
                </CardContent>
              </Card>
            ))}
          </div>
        </Section>
      )}

      <ServerConfigSection />
    </AppPage>
  );
}
