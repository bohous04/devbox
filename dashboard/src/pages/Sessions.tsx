import { useEffect, useRef, useState } from "react";
import { ChevronRight, Plus, Search, Terminal, Monitor, Star, ShieldCheck, Pencil, Square, RotateCcw, Trash2, ArrowLeftRight, Download, Folder, Box, Bell, Save, Share2 } from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  api, type ActivityEvent, type AgentName, type CcStatus, type SessionLive, type SessionUsage,
  type TreeProject,
} from "../api";
import { criticBadge, findingLines, type CriticReview } from "../criticView";
import {
  ActionButton, AppPage, ConfirmButton, EmptyState, RowsSkeleton, Section, StatGrid, StatusDot,
} from "../components/primitives";
import { Button } from "@/components/ui/button";
import { DesktopModal } from "../components/DesktopModal";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { agoLabel, bytes, compactNumber, czCurrency, durationLabel, stateLabel } from "../format";
import { AGENT_IDS, AGENT_PROFILES, SOLO, agentNameFor, defaultAgentFor, folderChoices, instaboxAgentBlock, profileFor, projectChoices, repoChoices, sessionsFor, soleProject } from "../newSession";
import { CC_EVENT_TYPES, fleetBadge, historyLine, rowState, type HistoryTone } from "../ccUpkeepView";
import { agentSwitchError } from "../sessionsView";
import { terminalTabUrl } from "../terminalRoute";
import { useNow, useStore } from "../store";
import { FormDialog } from "../components/FormDialog";
import { SessionCodexAccount } from "../components/SessionCodexAccount";
import { InstaboxPanel } from "../components/InstaboxPanel";
import { ActiveShares, ShareTerminalDialog } from "../components/ShareTerminal";
import { hostDisabledReason, jobErrorText, JOB_STEP_LABEL, type IbxStatusDto, type PlacementDto } from "../instaboxView";

const selectCls = "h-11 w-full rounded-md border bg-background px-2 text-sm text-foreground disabled:cursor-not-allowed disabled:opacity-50";
const labelCls = "flex flex-col gap-1.5 text-sm font-medium";

const CRITIC_TONE: Record<"ok" | "warn" | "danger", string> = {
  ok: "border-emerald-600/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  warn: "border-amber-600/40 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  danger: "border-red-600/40 bg-red-500/10 text-red-700 dark:text-red-400",
};
const HISTORY_TONE: Record<HistoryTone, string> = {
  ok: "text-emerald-600 dark:text-emerald-400",
  info: "text-muted-foreground",
  warn: "text-amber-600 dark:text-amber-400",
  danger: "text-red-600 dark:text-red-400",
};

/* ============================== new session ============================== */

function NewSession({ open, onClose, onStarted }: { open: boolean; onClose: () => void; onStarted: (id: string, message: string) => Promise<void> }) {
  const { live } = useStore();
  const [tree, setTree] = useState<TreeProject[] | null>(null);
  const [folder, setFolder] = useState("");
  const [project, setProject] = useState("");
  const [repo, setRepo] = useState("");
  const [agent, setAgent] = useState<AgentName>("claude");
  const [host, setHost] = useState<"vps" | "instabox">("vps");
  const [ibxStatus, setIbxStatus] = useState<IbxStatusDto>({ enabled: false });
  const [placement, setPlacement] = useState<PlacementDto | null>(null);
  const [step, setStep] = useState<string | null>(null);
  const [ibxFailed, setIbxFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Flipped to false on unmount — polling job/baseJob must not keep calling the API or touch
  // the state of a disposed component after the page is closed (see startInstabox below).
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  useEffect(() => {
    if (!open || tree !== null) return;
    api.tree().then(setTree).catch((e) => setErr((e as Error).message));
  }, [open, tree]);

  // VPS capacity and load change between openings → read on every opening.
  // An InstaBox API outage must not break the form: status is then "not configured", host VPS.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    void Promise.allSettled([api.instaboxStatus(), api.placement()]).then(([st, pl]) => {
      if (!alive) return;
      const status: IbxStatusDto = st.status === "fulfilled" ? st.value : { enabled: false };
      const p = pl.status === "fulfilled" ? pl.value : null;
      setIbxStatus(status);
      setPlacement(p);
      setHost(p?.suggest === "instabox" && hostDisabledReason(status, false, instaboxAgentBlock(agent)) === null ? "instabox" : "vps");
    });
    return () => { alive = false; };
  }, [open]);

  const folders = tree ? folderChoices(tree) : [];
  const projects = tree && folder ? projectChoices(tree, folder) : [];
  const repos = tree && folder && project ? repoChoices(tree, folder, project) : [];
  const selected = repos.find((r) => r.value === repo);
  // Solo has no repo of its own (see SOLO) and the server does not accept `fresh` for it (openSolo),
  // so the "New session" option makes sense only for a real repo.
  const existing = repo && repo !== SOLO ? sessionsFor(live?.sessions ?? [], project, repo) : [];
  const ibxDisabled = hostDisabledReason(ibxStatus, repo === SOLO, instaboxAgentBlock(agent));
  const onIbx = host === "instabox" && !ibxDisabled;

  // A folder with a single project → we fill in the project ourselves, so the user on mobile
  // immediately sees the repo picker instead of a confusing empty middle step.
  useEffect(() => {
    if (!tree || !folder) return;
    const sp = soleProject(tree, folder);
    if (sp) setProject(sp);
  }, [folder, tree]);

  // Switching to a proxy profile (or another reason for a block) clears an earlier InstaBox choice —
  // otherwise the form would submit host:"instabox" with a blocked agent and hit a 400.
  useEffect(() => {
    if (host === "instabox" && ibxDisabled) setHost("vps");
  }, [host, ibxDisabled]);

  if (!open) return null;

  async function startVps(fresh?: boolean) {
    if (!folder || !project || !repo || busy) return;
    setErr(null); setIbxFailed(false); setBusy(true);
    try {
      const r = repo === SOLO
        ? await api.openSolo({ folder, project, agent })
        : await api.openSession({ folder, project, repo, cloneUrl: selected?.cloneUrl, agent, fresh });
      setRepo("");
      await onStarted(r.session.id, r.pull?.status === "conflict"
        ? "Session started. The agent is resolving a pull conflict."
        : "Session is ready.");
      onClose();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  // InstaBox always creates a NEW session (R3) and runs as a job: the form stays open
  // and shows the step until the machine, clone and container are ready.
  async function startInstabox() {
    if (!folder || !project || !repo || busy) return;
    if (!selected?.cloneUrl) { setErr("This repo has no clone URL."); return; }
    setErr(null); setIbxFailed(false); setBusy(true); setStep("preflight");
    try {
      const { jobId, sessionId } = await api.openInstabox({ folder, project, repo, cloneUrl: selected.cloneUrl, agent });
      for (;;) {
        if (!aliveRef.current) return;
        const job = await api.instaboxJob(jobId);
        if (!aliveRef.current) return;
        setStep(job.step);
        if (job.status === "error") throw new Error(jobErrorText(job.step, job.error));
        if (job.status === "done") break;
        await new Promise((r) => setTimeout(r, 1000));
      }
      setRepo("");
      await onStarted(sessionId, "Session is ready on InstaBox.");
      onClose();
    } catch (e) { if (aliveRef.current) { setErr((e as Error).message); setIbxFailed(true); } }
    finally { if (aliveRef.current) { setBusy(false); setStep(null); } }
  }

  const start = (fresh?: boolean) => (onIbx ? startInstabox() : startVps(fresh));

  return (
    <FormDialog open={open} onOpenChange={(next) => { if (!next) onClose(); }} title="New session" description="Choose a workspace and the agent you want to work with." busy={busy}>
      <form className="flex flex-col gap-5" onSubmit={(e) => { e.preventDefault(); void start(); }}>
        {!tree && !err && <p role="status" className="text-sm text-muted-foreground">Loading workspaces…</p>}
        <div className="grid gap-4 sm:grid-cols-2">
          <label className={labelCls}>
            Folder
            <select className={selectCls} value={folder} disabled={!tree || busy}
              onChange={(e) => { setFolder(e.target.value); setProject(""); setRepo(""); }}>
              <option value="">—</option>
              {folders.map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
          </label>
          <label className={labelCls}>
            Project
            <select className={selectCls} value={project} disabled={!folder || busy}
              onChange={(e) => { setProject(e.target.value); setRepo(""); }}>
              <option value="">—</option>
              {projects.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </label>
          <label className={labelCls}>
            Repo
            <select className={selectCls} value={repo} disabled={!project || busy}
              onChange={(e) => { setRepo(e.target.value); setAgent(defaultAgentFor(tree ?? [], folder, project, e.target.value)); }}>
              <option value="">—</option>
              {repos.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
          </label>
          <label className={labelCls}>
            Agent
            <select className={selectCls} value={agent} disabled={!repo || busy} onChange={(e) => setAgent(e.target.value as AgentName)}>
              {AGENT_IDS.map((id) => (
                <option key={id} value={id}>
                  {AGENT_PROFILES[id].label}{AGENT_PROFILES[id].yolo ? " (yolo)" : ""}
                </option>
              ))}
            </select>
          </label>
          <fieldset className="sm:col-span-2">
            <legend className={labelCls}>Where it runs</legend>
            <div className="mt-2 flex gap-2">
              <Button type="button" variant={host === "vps" ? "default" : "outline"} disabled={busy} onClick={() => setHost("vps")}>VPS</Button>
              <Button type="button" variant={onIbx ? "default" : "outline"} disabled={busy || !!ibxDisabled} title={ibxDisabled ?? undefined} onClick={() => setHost("instabox")}>InstaBox</Button>
            </div>
            {placement?.reason && <p className="mt-2 text-sm text-muted-foreground">VPS is busy ({placement.reason}) — InstaBox recommended.</p>}
            {onIbx && <p className="mt-2 text-sm text-muted-foreground">Starts a new session on its own machine with a fresh clone. No review, prod-db, Finder or previews; the agent's browser is visible under Desktop.</p>}
            {ibxDisabled && <p className="mt-2 text-xs text-muted-foreground">{ibxDisabled}</p>}
          </fieldset>
        </div>
        {busy && step && <p role="status" className="text-sm text-muted-foreground">{JOB_STEP_LABEL[step] ?? step}…</p>}
        <div className="flex flex-wrap justify-end gap-2 border-t pt-4">
          <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button>
          {ibxFailed && <Button type="button" variant="outline" disabled={busy} onClick={() => { setHost("vps"); void startVps(); }}>Open on VPS</Button>}
          {!onIbx && existing.length > 0 && <Button type="button" variant="outline" disabled={!repo || busy} onClick={() => void startVps(true)}>Create another</Button>}
          <Button type="submit" disabled={!repo || busy}>{busy ? "Starting…" : ibxFailed && onIbx ? "Try again" : onIbx ? "Start on InstaBox" : existing.length > 0 ? "Open existing" : "Start session"}</Button>
        </div>
        {/* A repo in the old layout (shared working directory) cannot give another session its own
            worktree or branch — only its own container. Two agents on one git index
            must be announced up front, not discovered from the behavior. */}
        {!onIbx && existing.length > 0 && selected && selected.cloned && !selected.bare && (
          <span className="text-xs font-medium text-muted-foreground">
            New session shares this repo's working directory and branch (own container, same files).
          </span>
        )}
        {err && <p role="alert" className="text-sm text-destructive">{err}</p>}
      </form>
    </FormDialog>
  );
}

/* ============================== cc upkeep ============================== */

function CcVersionBar({ status, onRun, onReload }: {
  status: CcStatus | null; onRun: () => Promise<void>; onReload: () => Promise<void>;
}) {
  const badge = fleetBadge(status);
  const [err, setErr] = useState<string | null>(null);
  return (
    <Card>
      <CardContent className="flex flex-wrap items-center gap-x-4 gap-y-2 p-4">
        <div className="text-sm">
          <span className="text-muted-foreground">latest: </span>
          <code className="font-mono">{status?.latest ?? "?"}</code>
          <span className="ml-3 text-muted-foreground">in image: </span>
          <code className="font-mono">{status?.image ?? "?"}</code>
        </div>
        <Badge variant={badge.variant}>{badge.label}</Badge>
        <span className="flex-1" />
        <div className="flex gap-2">
          <ActionButton variant="outline" size="sm" onAction={onReload} onError={setErr}>Refresh</ActionButton>
          <ActionButton size="sm" onAction={onRun} onError={setErr}>Update all</ActionButton>
        </div>
        {err && <span className="w-full text-xs font-medium text-destructive">Error: {err}</span>}
      </CardContent>
    </Card>
  );
}

function CcHistory({ events }: { events: ActivityEvent[] }) {
  const now = useNow(30_000);
  if (events.length === 0) {
    return <EmptyState title="Nothing has happened yet" hint="Version upgrades and skipped restarts show up here." />;
  }
  return (
    <Card><CardContent className="flex flex-col divide-y p-0">
      {events.map((e) => {
        const l = historyLine(e.type, e.data);
        const who = e.session_id?.startsWith("dev-") ? e.session_id.slice(4) : e.session_id ?? "all sessions";
        return (
          <div key={e.id} className="grid grid-cols-[auto_1fr] items-baseline gap-x-3 gap-y-0.5 px-4 py-2.5 sm:grid-cols-[6rem_9rem_1fr]">
            <span className="font-mono text-xs text-muted-foreground" title={new Date(e.ts).toLocaleString("en-US")}>
              {agoLabel(now - e.ts)}
            </span>
            <span className="truncate font-mono text-xs font-semibold">{who}</span>
            <span className={cn("col-span-2 text-sm sm:col-span-1", HISTORY_TONE[l.tone])}>{l.text}</span>
          </div>
        );
      })}
    </CardContent></Card>
  );
}

/* ============================== session ============================== */

const STATE_ORDER: Record<string, number> = { working: 0, waiting: 1, idle: 2 };

function sortSessions(list: SessionLive[]): SessionLive[] {
  return [...list].sort((a, b) => {
    const runA = a.status === "running" ? 0 : 1;
    const runB = b.status === "running" ? 0 : 1;
    if (runA !== runB) return runA - runB;
    const st = (STATE_ORDER[a.claudeState] ?? 3) - (STATE_ORDER[b.claudeState] ?? 3);
    if (a.status === "running" && st !== 0) return st;
    return b.last_active_at - a.last_active_at;
  });
}

/** Opens the session terminal in a NEW tab — a full page /#/terminal/:id.
 *  Deliberately window.open (not <a>): a tab opened by a script can then close
 *  itself with the Close button (see TerminalPage). The address is built by terminalRoute.ts —
 *  HashRouter needs the path in the hash; the path form ended up on Overview. */
function openTerminalTab(id: string): void {
  window.open(terminalTabUrl(id), "_blank", "noopener");
}

function SessionRow({ s, usage, cc, ccLatest, open, onToggle, onChanged, onShared }: {
  s: SessionLive; usage?: SessionUsage;
  cc?: CcStatus["sessions"][number]; ccLatest: string | null;
  open: boolean; onToggle: () => void;
  onChanged: () => Promise<void>;
  onShared: () => void;
}) {
  const now = useNow(1000);
  const [err, setErr] = useState<string | null>(null);
  const [reviews, setReviews] = useState<CriticReview[] | null>(null);
  const [showFindings, setShowFindings] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [nameVal, setNameVal] = useState("");
  const [savingName, setSavingName] = useState(false);
  const [desktop, setDesktop] = useState(false);
  const [sharing, setSharing] = useState(false);

  const running = s.status === "running";
  const important = s.important === 1;
  const critic = s.critic === 1;
  const nick = s.name?.trim() || null;
  const badge = criticBadge(reviews?.[0] ?? null);
  // Live agent switch: the select holds the TARGET profile, default = current. Derived
  // (pick ?? current), not via an effect — after a row refresh (onChanged after the switch) the
  // selection lines up with reality by itself and is never a render behind.
  const currentAgent = agentNameFor(s.agent);
  const [pick, setPick] = useState<AgentName | null>(null);
  const agentPick = pick ?? currentAgent;

  // The critic verdict is fetched only by an open card with the critic enabled — a closed row
  // would not show it anyway and with twenty sessions it would be a pointless storm of requests.
  useEffect(() => {
    if (!open || !critic) { setReviews(null); return; }
    let alive = true;
    api.reviews(s.id).then((r) => { if (alive) setReviews(r); }).catch(() => { if (alive) setReviews(null); });
    return () => { alive = false; };
  }, [open, critic, s.id, s.last_active_at]);

  const ccState = cc ? rowState(cc, ccLatest) : null;

  return (
    <Card className={cn("overflow-hidden", open && "border-foreground/20")}>
      <div className="flex items-center gap-2 px-2 sm:px-3">
        <button className="flex min-h-[76px] min-w-0 flex-1 items-center gap-3 rounded-md px-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={onToggle} aria-expanded={open} aria-controls={`details-${s.id}`}>
          <ChevronRight className={cn("size-4 flex-none text-muted-foreground", open && "rotate-90")} />
          <StatusDot kind={running ? s.claudeState : "stopped"} />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2"><span className="truncate text-sm font-semibold">{nick ?? s.repo}</span>{important && <Star className="size-3.5 shrink-0 text-muted-foreground" aria-label="Important" />}{critic && <ShieldCheck className="size-3.5 shrink-0 text-muted-foreground" aria-label="Critic enabled" />}{s.host === "instabox" && <Badge variant="secondary" className="text-[10px]">InstaBox</Badge>}</span>
            <span className="mt-1 block truncate text-xs text-muted-foreground">{s.project} · {profileFor(s.agent).short}{s.accountId ? ` · ${s.accountId}` : ""}</span>
          </span>
          <span className="hidden shrink-0 text-xs text-muted-foreground sm:block">{running ? stateLabel(s.claudeState) : "Stopped"}</span>
          {ccState === "outdated" && <Badge variant="outline" className="hidden text-[10px] sm:inline-flex">CC update</Badge>}
        </button>
        {running && <Button size="sm" variant="outline" className="min-h-11" aria-label={`Open terminal for ${nick ?? s.repo}`} onClick={() => openTerminalTab(s.id)}><Terminal className="size-4" /><span className="hidden sm:inline">Terminal</span></Button>}
        {running && s.host === "instabox" && <Button size="sm" variant="outline" className="min-h-11" aria-label={`Open desktop for ${nick ?? s.repo}`} onClick={() => setDesktop(true)}><Monitor className="size-4" /><span className="hidden sm:inline">Desktop</span></Button>}
        {/* Terminal sharing only on the VPS (InstaBox devd rejects with 409). */}
        {running && s.host !== "instabox" && <Button size="sm" variant="outline" className="min-h-11" aria-label={`Share terminal of ${nick ?? s.repo}`} onClick={() => setSharing(true)}><Share2 className="size-4" /><span className="hidden sm:inline">Share</span></Button>}
        {running && s.host !== "instabox" && <ShareTerminalDialog sessionId={s.id} title={nick ?? s.repo} open={sharing} onOpenChange={setSharing} onCreated={onShared} />}
        {desktop && <DesktopModal sessionId={s.id} title={nick ?? s.repo} onClose={() => setDesktop(false)} />}
      </div>
      {open && (
          <div id={`details-${s.id}`}>
            <CardContent className="flex flex-col gap-4 border-t bg-muted/10 p-4 sm:p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0"><p className="flex items-center gap-2 text-sm font-medium"><Folder className="size-4 shrink-0 text-muted-foreground" /><span className="break-all">{s.project}/{s.repo}</span></p><p className="mt-1 text-xs text-muted-foreground">{s.folder}{s.solo === 1 ? " · Solo workspace" : ""} · {running ? stateLabel(s.claudeState) : "Stopped"}</p></div>
                <Button size="sm" variant="ghost" onClick={() => { setErr(null); setRenaming(true); setNameVal(s.name ?? ""); }}><Pencil className="size-4" />Rename</Button>
              </div>

              <StatGrid items={[
                { label: "Uptime", value: running ? durationLabel(now - s.created_at) : "—" },
                { label: "CPU", value: running ? `${Math.round(s.cpuPct)} %` : "—" },
                { label: "RAM", value: running ? bytes(s.memBytes) : "—" },
                { label: "Tokens today", value: usage ? compactNumber(usage.tokens) : "—" },
                { label: "Cost today", value: usage ? czCurrency(usage.cost) : "—" },
              ]} />

              <FormDialog open={renaming} onOpenChange={setRenaming} busy={savingName} title="Rename session" description="Give this workspace a recognizable name. Leave empty to use the repository name.">
                <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (savingName) return; setSavingName(true); void (async () => { try { await api.setName(s.id, nameVal.trim()); await onChanged(); setRenaming(false); } catch (e) { setErr((e as Error).message); } finally { setSavingName(false); } })(); }}>
                  <label className={labelCls}>Session name<Input value={nameVal} onChange={(e) => setNameVal(e.target.value)} placeholder={s.repo} /></label>
                  {err && <p role="alert" className="text-sm text-destructive">{err}</p>}
                  <div className="flex justify-end gap-2"><Button type="button" variant="ghost" disabled={savingName} onClick={() => setRenaming(false)}>Cancel</Button><Button type="submit" disabled={savingName}><Save className="size-4" />{savingName ? "Saving…" : "Save name"}</Button></div>
                </form>
              </FormDialog>

              <section className="rounded-lg border p-4">
                <div className="mb-3"><h3 className="text-sm font-semibold">Alerts &amp; review</h3><p className="mt-1 text-xs text-muted-foreground">Choose how this session gets your attention and checks its work.</p></div>
                <div className="flex flex-wrap gap-2 [&_button]:min-h-11">
                <ActionButton
                  variant={important ? "secondary" : "outline"} size="sm" aria-pressed={important} onError={setErr}
                  title="Loud phone alert on completion, blocking, or getting stuck"
                  onAction={async () => { await api.setImportant(s.id, !important); await onChanged(); }}
                  icon={<Bell className="size-4" />}>{important ? "Priority alerts on" : "Priority alerts off"}</ActionButton>

                <ActionButton
                  variant={critic ? "secondary" : "outline"} size="sm" aria-pressed={critic} onError={setErr}
                  title="An independent critic checks every turn before the agent reports done"
                  onAction={async () => { await api.setCritic(s.id, !critic); await onChanged(); }}
                  icon={<ShieldCheck className="size-4" />}>{critic ? "Review enabled" : "Enable review"}</ActionButton>

                </div>
              {badge && (
                <div>
                  <button
                    aria-expanded={showFindings}
                    className={cn("inline-flex min-h-11 items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium", CRITIC_TONE[badge.kind])}
                    onClick={() => setShowFindings((v) => !v)}
                  ><ShieldCheck className="size-4" />{badge.text}<ChevronRight className={cn("size-4", showFindings && "rotate-90")} /></button>
                  {showFindings && reviews?.[0] && (
                    <ul className="mt-2 list-disc pl-[18px] text-xs leading-relaxed opacity-85">
                      {findingLines(reviews[0]).map((line, i) => <li key={i}>{line}</li>)}
                      {reviews[0].evidence && (
                        <li className="-ml-[18px] mt-1.5 list-none whitespace-pre-wrap font-mono opacity-70">{reviews[0].evidence}</li>
                      )}
                    </ul>
                  )}
                </div>
              )}
              </section>

              <section className="space-y-3 rounded-lg border p-4">
                <div><h3 className="text-sm font-semibold">Agent &amp; account</h3><p className="mt-1 text-xs text-muted-foreground">{profileFor(s.agent).label}{s.accountId ? ` · ${s.accountId}` : ""}</p></div>
              {/* Live agent (harness) switch — devd restarts the panes on the new
                  profile in place (without recreating the container): claude→claude* keeps
                  the conversation via --resume, switching to a different CLI loses it. */}
              {running && (
                <div className="flex flex-wrap items-center gap-2 rounded-md bg-muted/40 px-3 py-2 text-xs">
                  <span className="text-sm text-muted-foreground">Switch profile</span>
                  <span className="flex-1" />
                  <select
                    aria-label="Switch agent profile"
                    className="h-11 max-w-full rounded-md border bg-background px-2 text-sm text-foreground"
                    value={agentPick}
                    onChange={(e) => setPick(e.target.value as AgentName)}
                  >
                    {AGENT_IDS.map((a) => <option key={a} value={a}>{AGENT_PROFILES[a].label}</option>)}
                  </select>
                  <ConfirmButton
                    size="sm" variant="outline" disabled={agentPick === currentAgent}
                    confirmLabel="Restart onto it?" onError={setErr}
                    title="Restarts the agent in every window — an in-flight turn is lost; switching to a different CLI drops the conversation"
                    onConfirm={async () => {
                      const r = await api.switchAgent(s.id, agentPick);
                      const msg = agentSwitchError(r, AGENT_PROFILES[agentPick].label);
                      if (msg) throw new Error(msg);
                      await onChanged();
                    }}
                  >
                    <ArrowLeftRight className="size-4" />Switch agent
                  </ConfirmButton>
                </div>
              )}

              {running && currentAgent === "codex" && (
                <SessionCodexAccount sessionId={s.id} onChanged={onChanged} />
              )}

                {/* Without accountId there is nothing to switch to — an old container without profile
                    mounts (or a stopped session whose leases stop() released).
                    switchAccount on the server does not check the profile path, so
                    it would not be a no-op: confirming would send /exit to the pane (killing
                    the turn in progress) and claude would restart with CLAUDE_CONFIG_DIR
                    pointing into nothing — not logged in, no history. For a stopped
                    session the impact is harmless (the server returns 409 before
                    anything restarts), but the button has no business being there anyway. */}
                {s.accountId && currentAgent === "claude" && (
                  <ConfirmButton size="sm" variant="outline" confirmLabel="Restart panels?"
                    onError={setErr}
                    onConfirm={async () => {
                      // M1 (final review): "no-account"/"failed" come back as HTTP 200
                      // with ok:false (see devd/src/api.ts switch-account route) — j()
                      // only throws on non-2xx, so this used to swallow both silently
                      // and never light up onError.
                      const r = await api.switchAccount(s.id);
                      if (!r.ok) {
                        throw new Error(r.accountId
                          ? `Couldn't restart any panel onto ${r.label ?? r.accountId} — check the container.`
                          : "No account available for this session.");
                      }
                      await onChanged();
                    }}>
                    <ArrowLeftRight className="size-4" />Switch account
                  </ConfirmButton>
                )}
              </section>

              {cc && (
                <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-xs">
                  <span className="text-muted-foreground">Claude Code</span>
                  <code className="font-mono">{cc.version ?? "?"}</code>
                  {ccState === "outdated" && <Badge variant="destructive" className="text-[10px]">outdated</Badge>}
                  <span className="flex-1" />
                  <ActionButton size="sm" variant="outline" onError={setErr}
                    onAction={async () => { await api.ccUpkeepRun(s.id); await onChanged(); }} icon={<Download className="size-4" />}>Update</ActionButton>
                </div>
              )}


              <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
                <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground"><Box className="size-3.5 shrink-0" /><code className="truncate" title={s.container}>{s.container}</code></span>
                <div className="flex flex-wrap gap-2 [&_button]:min-h-11">
                {running ? (
                  <ActionButton variant="outline" size="sm" onError={setErr}
                    onAction={async () => { await api.stop(s.id); await onChanged(); }} icon={<Square className="size-4" />}>Stop</ActionButton>
                ) : s.solo === 1 ? (
                  <ActionButton variant="outline" size="sm" onError={setErr}
                    onAction={async () => { await api.restart(s.id); await onChanged(); }} icon={<RotateCcw className="size-4" />}>Restart</ActionButton>
                ) : <span />}

                {s.solo === 1 ? (
                  <ConfirmButton variant="outline" size="sm" confirmLabel="Delete workspace" onError={setErr}
                    onConfirm={async () => { await api.end(s.id, "delete"); await onChanged(); }}><Trash2 className="size-4" />End session</ConfirmButton>
                ) : (
                  <ConfirmButton variant="outline" size="sm" confirmLabel="Yes, end it" onError={setErr}
                    onConfirm={async () => { await api.end(s.id); await onChanged(); }}><Trash2 className="size-4" />End session</ConfirmButton>
                )}

                </div>
              </div>
              {err && <div role="alert" className="text-sm text-destructive">{err}</div>}
            </CardContent>
          </div>
        )}
    </Card>
  );
}

/* ============================== page ============================== */

export function Sessions() {
  const { live, refresh } = useStore();
  const sessions = sortSessions(live?.sessions ?? []);
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const [usage, setUsage] = useState<Record<string, SessionUsage>>({});
  const [cc, setCc] = useState<CcStatus | null>(null);
  const [ccEvents, setCcEvents] = useState<ActivityEvent[]>([]);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [agentFilter, setAgentFilter] = useState("all");
  const visible = sessions.filter((s) => (statusFilter === "all" || (statusFilter === "running" ? s.status === "running" : s.status !== "running"))
    && (agentFilter === "all" || agentNameFor(s.agent) === agentFilter)
    && [s.name, s.repo, s.project, s.folder, s.id, s.accountId].some((v) => v?.toLowerCase().includes(query.toLowerCase())));

  const [newOpen, setNewOpen] = useState(false);
  const [sharesVersion, setSharesVersion] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);

  const openId = params.get("open");
  function toggle(id: string) {
    const next = new URLSearchParams(params);
    if (openId === id) next.delete("open"); else next.set("open", id);
    setParams(next, { replace: true });
  }

  const loadUsage = () => api.sessionUsage()
    .then((rows) => setUsage(Object.fromEntries(rows.map((r) => [r.id, r]))))
    .catch(() => {});
  const loadCc = () => Promise.allSettled([api.ccUpkeep(), api.events({ limit: 200 })]).then(([st, ev]) => {
    if (st.status === "fulfilled") setCc(st.value);
    if (ev.status === "fulfilled") setCcEvents(ev.value.filter((e) => CC_EVENT_TYPES.includes(e.type)).slice(0, 15));
  });

  useEffect(() => {
    let alive = true;
    const tick = () => { if (alive) loadUsage(); };
    tick();
    void loadCc();
    const h = setInterval(tick, 5000);
    return () => { alive = false; clearInterval(h); };
  }, []);

  // Deep link from a Pushover notification: /sessions?terminal=<id>. The terminal lives on
  // its own route, so an incoming link here is just redirected as soon as we see
  // the session running (before that the ws to a non-running session would just fail).
  useEffect(() => {
    const want = params.get("terminal");
    if (want && sessions.some((s) => s.id === want && s.status === "running")) {
      navigate(`/terminal/${encodeURIComponent(want)}`, { replace: true });
    }
  }, [params, sessions, navigate]);

  const ccById = Object.fromEntries((cc?.sessions ?? []).map((x) => [x.id, x]));

  async function refreshAll() { await refresh(); await Promise.all([loadUsage(), loadCc()]); }

  return (
    <AppPage
      title="Sessions"
      sub="Your workspaces, agents and conversations."
      actions={
        <Button className="min-h-11" onClick={() => setNewOpen(true)}><Plus className="size-4" />New session</Button>
      }
    >
      <NewSession open={newOpen} onClose={() => setNewOpen(false)} onStarted={async (id, message) => { await refreshAll(); const next = new URLSearchParams(params); next.set("open", id); setParams(next, { replace: true }); setNotice(message); setQuery(""); setAgentFilter("all"); setStatusFilter("all"); }} />

      {notice && <p role="status" className="mb-4 text-sm text-muted-foreground">{notice}</p>}
      <div className="mb-4 flex flex-col gap-3 sm:flex-row">
        <div className="relative flex-1"><Search className="pointer-events-none absolute left-3 top-3.5 size-4 text-muted-foreground" /><Input type="search" aria-label="Search sessions" placeholder="Search workspaces…" className="h-11 pl-9" value={query} onChange={(e) => setQuery(e.target.value)} /></div>
        <select aria-label="Filter session status" className={cn(selectCls, "sm:w-40")} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}><option value="all">All statuses</option><option value="running">Running</option><option value="stopped">Stopped</option></select>
        <select aria-label="Filter agent" className={cn(selectCls, "sm:w-52")} value={agentFilter} onChange={(e) => setAgentFilter(e.target.value)}><option value="all">All agents</option>{AGENT_IDS.map((a) => <option key={a} value={a}>{AGENT_PROFILES[a].label}</option>)}</select>
      </div>
      <InstaboxPanel />
      <Section label="Workspaces" meta={live ? `${visible.length} of ${sessions.length}` : "Loading…"}>
        {!live ? <RowsSkeleton rows={4} /> : sessions.length === 0 ? (
          <EmptyState
            title="No sessions"
            hint="Start one with the button above, or from the terminal with the dev command."
          />
        ) : visible.length === 0 ? <EmptyState title="No matching sessions" hint="Try another name or change the filters." /> : (
          <div className="flex flex-col gap-2">
            {visible.map((s) => (
              <SessionRow
                key={s.id}
                s={s}
                usage={usage[s.id]}
                cc={ccById[s.id]}
                ccLatest={cc?.latest ?? null}
                open={openId === s.id}
                onToggle={() => toggle(s.id)}
                onChanged={refreshAll}
                onShared={() => setSharesVersion((v) => v + 1)}
              />
            ))}
          </div>
        )}
      </Section>

      <ActiveShares sessions={sessions} version={sharesVersion} onChanged={refreshAll} />

      <details className="rounded-lg border p-4">
        <summary className="min-h-11 cursor-pointer content-center text-sm font-medium">Version maintenance &amp; history</summary>
        <div className="mt-4 space-y-4">
          <CcVersionBar status={cc} onRun={async () => { await api.ccUpkeepRun(); await refreshAll(); }} onReload={loadCc} />
          <CcHistory events={ccEvents} />
        </div>
      </details>

    </AppPage>
  );
}
