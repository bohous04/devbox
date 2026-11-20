import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, FolderGit2, Search } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { api, type AgentName, type SessionLive, type SessionRuntime, type TreeProject } from "../api";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import {
  AGENT_IDS, AGENT_PROFILES, SOLO, chatRuntimeBlock, defaultAgentFor, instaboxAgentBlock, repoChoices, runningInOtherRuntime,
  runtimeAfterDefault, runtimeChoice, sessionsFor, tmuxRuntimeBlock,
} from "../newSession";
import { getDefaultRuntime, validateConfig } from "../configEdit";
import { highlight, pickKey, repoSearch, searchTerms } from "../repoSearch";
import { openedNotice } from "../sessionsView";
import { useStore } from "../store";
import { Composer } from "../components/chat/Composer";
import { AgentGlyph } from "../components/chat/Switchers";
import { hostDisabledReason, jobErrorText, JOB_STEP_LABEL, type IbxStatusDto, type PlacementDto } from "../instaboxView";

/** Route /new — start a session: pick the repo, type the first message in the chat composer, go. The interface
 *  (chat/terminal) and the host (VPS/InstaBox) sit under the box; every guard is the one in newSession.ts. */
export function NewSession() {
  const { live, refresh } = useStore();
  const navigate = useNavigate();
  const [tree, setTree] = useState<TreeProject[] | null>(null);
  const [folder, setFolder] = useState("");
  const [project, setProject] = useState("");
  const [repo, setRepo] = useState("");
  const [agent, setAgent] = useState<AgentName>("claude");
  const [host, setHost] = useState<"vps" | "instabox">("vps");
  // The runtime the user wants: null until they pick or the configured default arrives (start waits for it, so
  // nothing starts in a guessed runtime); `choice` below is what actually starts.
  const [runtime, setRuntime] = useState<SessionRuntime | null>(null);
  const [ibxStatus, setIbxStatus] = useState<IbxStatusDto>({ enabled: false });
  const [placement, setPlacement] = useState<PlacementDto | null>(null);
  const [step, setStep] = useState<string | null>(null);
  const [ibxFailed, setIbxFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  // The composer's text: what may start with it is decided here (InstaBox and a running terminal take none).
  const [draft, setDraft] = useState("");
  // Flipped to false on unmount — polling the InstaBox job must not keep calling the API or touch the state of a
  // disposed page after the user navigated away (see startInstabox below).
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  useEffect(() => { document.title = "devbox · New session"; }, []);

  useEffect(() => {
    api.tree().then(setTree).catch((e) => setErr((e as Error).message));
  }, []);

  // VPS capacity and load change between visits → read on every visit, with the default runtime.
  // An InstaBox API outage must not break the page: status is then "not configured", host VPS.
  useEffect(() => {
    let alive = true;
    void Promise.allSettled([api.instaboxStatus(), api.placement(), api.config()]).then(([st, pl, cfg]) => {
      if (!alive) return;
      const status: IbxStatusDto = st.status === "fulfilled" ? st.value : { enabled: false };
      const p = pl.status === "fulfilled" ? pl.value : null;
      let def: SessionRuntime | null = null;
      try {
        if (cfg.status === "rejected") throw cfg.reason;
        const loaded = getDefaultRuntime(validateConfig(cfg.value));
        def = loaded;
        setRuntime((picked) => runtimeAfterDefault(picked, loaded));
      } catch (e) { setErr(`Could not read the default runtime: ${(e as Error).message}`); }
      setIbxStatus(status);
      setPlacement(p);
      // Under a chat default the suggestion stays a hint: InstaBox is tmux-only, picking it would switch the runtime.
      setHost(p?.suggest === "instabox" && def === "tmux" && hostDisabledReason(status, false, instaboxAgentBlock(agent)) === null ? "instabox" : "vps");
    });
    return () => { alive = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- once per visit, with the agent at that moment

  const repos = tree && folder && project ? repoChoices(tree, folder, project) : [];
  const selected = repos.find((r) => r.value === repo);
  // Solo has no repo of its own (see SOLO) and the server does not accept `fresh` for it (openSolo),
  // so "Create another" makes sense only for a real repo.
  const ibxDisabled = hostDisabledReason(ibxStatus, repo === SOLO, runtime === "chat" ? chatRuntimeBlock(agent, "instabox") : instaboxAgentBlock(agent));
  const onIbx = host === "instabox" && !ibxDisabled;
  const chatDisabled = repo === SOLO ? "Chat sessions need a repo (no claudeSolo)" : chatRuntimeBlock(agent, onIbx ? "instabox" : "vps");
  const tmuxDisabled = tmuxRuntimeBlock(agent);
  // An agent/host the wanted runtime cannot run starts in the other one, said under the toggle, never silently.
  const choice = runtime === null ? null : runtimeChoice(runtime, chatDisabled, tmuxDisabled);
  // The repo's sessions of both runtimes. The page names its runtime, so devd attaches only to a session of that
  // runtime (`existing`); a running one of the other runtime is offered to open instead of a second container.
  const repoSessions = repo && repo !== SOLO ? sessionsFor(live?.sessions ?? [], project, repo) : [];
  const existing = choice ? repoSessions.filter((s) => (s.runtime ?? "tmux") === choice.runtime) : [];
  const runningOther = choice ? runningInOtherRuntime(repoSessions, choice.runtime) : [];
  // The ones that can be opened from here first, so the cap never hides them.
  const listed = [...runningOther, ...repoSessions.filter((s) => !runningOther.includes(s))];

  // Switching to a proxy profile (or another reason for a block) clears an earlier InstaBox choice —
  // otherwise the page would submit host:"instabox" with a blocked agent and hit a 400.
  useEffect(() => {
    if (host === "instabox" && ibxDisabled) setHost("vps");
  }, [host, ibxDisabled]);

  function pickRepo(key: string) {
    if (key === "") { setFolder(""); setProject(""); setRepo(""); return; }
    const [f, p, r] = JSON.parse(key) as [string, string, string];
    setFolder(f); setProject(p); setRepo(r);
    setAgent(defaultAgentFor(tree ?? [], f, p, r));
  }

  // A terminal session opens in the Sessions list (its row expanded), a chat session on its own page.
  // The list reads the live store, so it is refreshed first: the new row is there to expand.
  async function opened(id: string, rt: SessionRuntime, message: string | null) {
    if (rt === "chat") { navigate(`/s/${encodeURIComponent(id)}`, { state: { notice: message } }); return; }
    await refresh();
    if (aliveRef.current) navigate(`/sessions?open=${encodeURIComponent(id)}`, { state: { notice: message } });
  }

  // `prompt`: the composer's text, trimmed; empty starts the session without one, as before. A failure is thrown to the
  // caller: from the composer it shows under the box and the text stays (Composer keeps it on a failed send).
  async function startVps(fresh?: boolean, prompt = "", sessionId?: string) {
    if (!folder || !project || !repo || busy || !choice) return;
    setErr(null); setIbxFailed(false); setBusy(true);
    try {
      const r = repo === SOLO
        ? await api.openSolo({ folder, project, agent })
        : await api.openSession({ folder, project, repo, cloneUrl: selected?.cloneUrl, agent, fresh, runtime: choice.runtime, ...(prompt ? { prompt } : {}), ...(sessionId ? { sessionId } : {}) });
      if (!aliveRef.current) return;
      await opened(r.session.id, choice.runtime, openedNotice(r.pull, choice.runtime));
    } finally { if (aliveRef.current) setBusy(false); }
  }
  // The buttons outside the composer show a failure on the page.
  const report = (p: Promise<void>) => { p.catch((e) => { if (aliveRef.current) setErr((e as Error).message); }); };

  // InstaBox always creates a NEW session (R3) and runs as a job: the page stays and shows the step until the
  // machine, clone and container are ready.
  async function startInstabox() {
    if (!folder || !project || !repo || busy) return;
    if (!selected?.cloneUrl) { setErr("This repo has no clone URL."); return; }
    setErr(null); setIbxFailed(false); setBusy(true); setStep("preflight");
    try {
      // The page names the runtime (InstaBox is tmux-only), so devd has no runtime to pick and sends no runtimeNotice.
      const { jobId, sessionId } = await api.openInstabox({ folder, project, repo, cloneUrl: selected.cloneUrl, agent, runtime: "tmux" });
      for (;;) {
        if (!aliveRef.current) return;
        const job = await api.instaboxJob(jobId);
        if (!aliveRef.current) return;
        setStep(job.step);
        if (job.status === "error") throw new Error(jobErrorText(job.step, job.error));
        if (job.status === "done") break;
        await new Promise((r) => setTimeout(r, 1000));
      }
      await opened(sessionId, "tmux", "Session is ready on InstaBox.");
    } catch (e) { if (aliveRef.current) { setErr((e as Error).message); setIbxFailed(true); } }
    finally { if (aliveRef.current) { setBusy(false); setStep(null); } }
  }

  // A running session of the other runtime is already up: show it, no devd open.
  function openRunning(s: SessionLive) {
    void opened(s.id, s.runtime ?? "tmux", "Session is running.");
  }

  const prompt = draft.trim();
  // What the typed text cannot go with, said before the press (devd refuses the same with the same reasons).
  const textBlock = prompt === "" ? null
    : onIbx ? "InstaBox sessions start without a prompt: clear the text, or run it on the VPS."
    : repo === SOLO ? "claudeSolo starts without a prompt: clear the text, or pick a repo."
    : choice?.runtime === "tmux" && prompt.startsWith("-") ? "A terminal session's first prompt can't start with '-' (the agent would read it as an option)."
    : null;
  // Typed text is new work: it always starts a new session with it. Empty keeps today's default, joining the repo's
  // session of this runtime when there is one. The other choice is the secondary row under the options.
  // The one devd joins: a running session first (joinableSessionId), so the summary names the right one.
  const reusable = onIbx ? null : existing.find((s) => s.status === "running") ?? existing[0] ?? null;
  const start = () => (onIbx ? startInstabox() : prompt !== "" ? startVps(reusable !== null, prompt) : startVps());
  const startLabel = ibxFailed && onIbx ? "Try again" : onIbx ? "Start on InstaBox" : reusable && prompt === "" ? "Open existing" : "Start session";
  const canStart = !!repo && !busy && !!choice && textBlock === null;
  // Continuing takes the message only where devd can deliver it: a running terminal's agent has already started.
  const continueTakesPrompt = reusable !== null && !(choice?.runtime === "tmux" && reusable.status === "running");

  const where = onIbx ? "on InstaBox" : "on the VPS";
  const what = choice?.runtime === "chat" ? "chat" : "terminal";
  const summary = !repo ? null
    : !choice ? "Pick an interface: the default runtime is not loaded."
    : prompt !== "" && textBlock === null ? `Starts a new ${what} session ${where} with your message.`
    : reusable && prompt === "" ? `Opens ${reusable.id} (${what}, ${reusable.status}).`
    : `Starts a new ${what} session ${where}.`;

  return (
    <div className="mx-auto flex w-full max-w-[42rem] flex-col gap-4 pt-2 sm:min-h-[calc(100dvh-14rem)] sm:justify-center sm:pt-0">
      <h1 className="text-2xl font-semibold tracking-tight sm:text-center">What should we work on?</h1>

      <RepoPicker tree={tree} value={repo ? pickKey(folder, project, repo) : ""} disabled={busy} onPick={pickRepo} />

      <Composer
        running={false} onStop={async () => {}} card
        placeholder={!repo ? "Pick a repo, then describe the task… (optional)"
          : onIbx ? "InstaBox sessions start without a prompt"
          : repo === SOLO ? "claudeSolo starts without a prompt"
          : "Describe the task… (optional)"}
        fieldOff={onIbx ? "InstaBox sessions start without a prompt" : repo === SOLO ? "claudeSolo starts without a prompt" : undefined}
        imagesOff="Images can be added once the session is open"
        start={{ label: startLabel, ready: canStart }}
        onDraft={setDraft}
        onSend={async () => { await start(); }}
        controls={<AgentMenu agent={agent} disabled={!repo || busy} onPick={setAgent} />}
      />

      <div className="flex flex-col gap-3 px-1">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <Segmented label="Interface" options={[
            { value: "chat", label: "Chat", disabled: chatDisabled },
            { value: "tmux", label: "Terminal", disabled: tmuxDisabled },
          ]} value={choice?.runtime ?? null} busy={busy} onPick={(v) => setRuntime(v as SessionRuntime)} />
          <Segmented label="Where it runs" options={[
            { value: "vps", label: "VPS", disabled: null },
            { value: "instabox", label: "InstaBox", disabled: ibxDisabled },
          ]} value={onIbx ? "instabox" : "vps"} busy={busy} onPick={(v) => setHost(v as "vps" | "instabox")} />
        </div>

        <div className="flex flex-col gap-1.5 text-sm">
          {busy && step && <p role="status" className="text-muted-foreground">{JOB_STEP_LABEL[step] ?? step}…</p>}
          {!busy && summary && <p className="text-foreground/80">{summary}</p>}
          {textBlock && <p role="status" className="text-amber-700 dark:text-amber-300">{textBlock}</p>}
          {choice?.runtime === "chat" && <Hint>The agent runs behind the chat view; its terminal stays available as a tab.</Hint>}
          {repo && choice?.notice && <p role="status" className="text-amber-700 dark:text-amber-300">{choice.notice}</p>}
          {repo && !choice?.notice && chatDisabled && <Hint>{chatDisabled}</Hint>}
          {repo && !choice?.notice && tmuxDisabled && <Hint>{tmuxDisabled}</Hint>}
          {placement?.reason && <Hint>VPS is busy ({placement.reason}) — InstaBox recommended.</Hint>}
          {onIbx && <Hint>Starts a new session on its own machine with a fresh clone. No review, prod-db, Finder or previews; the agent's browser is visible under Desktop.</Hint>}
          {ibxDisabled && <Hint>{ibxDisabled}</Hint>}
          {/* A repo in the old layout (shared working directory) cannot give another session its own worktree or
              branch — only its own container. Two agents on one git index must be announced up front, not discovered
              from the behavior. */}
          {reusable && selected && selected.cloned && !selected.bare && (
            <Hint>A new session here shares this repo's working directory and branch (own container, same files).</Hint>
          )}
          {!tree && !err && <p role="status" className="text-muted-foreground">Loading workspaces…</p>}
          {err && <p role="alert" className="text-destructive">{err}</p>}
        </div>

        {(ibxFailed || reusable) && (
          <div className="flex flex-wrap gap-2">
            {reusable && (prompt === ""
              ? <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => report(startVps(true))}>Create another</Button>
              : <Button type="button" variant="ghost" size="sm" className="-ml-2 h-auto min-h-8 max-w-full whitespace-normal px-2 py-1 text-left font-normal text-muted-foreground hover:text-foreground" disabled={busy || textBlock !== null} onClick={() => report(startVps(false, continueTakesPrompt ? prompt : "", reusable.id))}>
                  Continue {reusable.id} instead{continueTakesPrompt ? "" : " (without your message)"}
                </Button>)}
            {ibxFailed && <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => { setHost("vps"); report(startVps()); }}>Open on VPS</Button>}
          </div>
        )}

        {repoSessions.length > 0 && (
          <section aria-label="Sessions of this repo" className="flex flex-col gap-1">
            <p className="flex items-center gap-1 text-xs text-muted-foreground">
              {repoSessions.length} {repoSessions.length === 1 ? "session" : "sessions"} in this repo ·
              <Button type="button" variant="link" size="sm" className="h-auto min-h-0 px-0 text-xs text-muted-foreground underline-offset-2 hover:text-foreground" aria-expanded={showAll} onClick={() => setShowAll((v) => !v)}>
                {showAll ? "Hide" : "Show"}
              </Button>
            </p>
            {showAll && (
              <ul className="flex flex-col">
                {listed.map((s) => (
                  <li key={s.id} className="flex min-h-9 flex-wrap items-center gap-x-2 text-sm">
                    <span className={cn("size-1.5 rounded-full", s.status === "running" ? "bg-emerald-500" : "bg-muted-foreground/40")} aria-hidden="true" />
                    <span className="font-mono text-[13px]">{s.id}</span>
                    <span className="text-muted-foreground">{s.runtime === "chat" ? "chat" : "terminal"} · {s.status}</span>
                    {runningOther.includes(s) && <Button type="button" size="sm" variant="ghost" className="ml-auto" disabled={busy} onClick={() => openRunning(s)}>Open</Button>}
                  </li>
                ))}
              </ul>
            )}
            {showAll && runningOther.length > 0 && <Hint>Starting here creates a {what} session next to the running {runningOther[0].runtime === "chat" ? "chat" : "terminal"} one.</Hint>}
          </section>
        )}
      </div>
    </div>
  );
}

function Hint({ children }: { children: ReactNode }) {
  return <p className="text-xs leading-5 text-muted-foreground">{children}</p>;
}

/** The repo: one searchable list over the tree's folder/project/repo cascade, grouped by project (a combobox: type to
 *  filter, arrows to move, Enter to pick; matches by repo or project first, see repoSearch). The chip shows the path. */
function RepoPicker({ tree, value, disabled, onPick }: { tree: TreeProject[] | null; value: string; disabled: boolean; onPick: (key: string) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const terms = searchTerms(query);
  const sections = repoSearch(tree ?? [], query);
  const flat = sections.flatMap((s) => s.groups.flatMap((g) => g.items));
  const at = Math.min(active, Math.max(flat.length - 1, 0));
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${at}"]`)?.scrollIntoView({ block: "nearest" });
  }, [at, open]);

  const [folder, project, repo] = value ? JSON.parse(value) as [string, string, string] : ["", "", ""];
  const path = value ? [folder, ...(project === folder ? [] : [project])].join(" / ") : null;
  const pick = (key: string) => { onPick(key); setOpen(false); };
  const marked = (text: string) => highlight(text, terms).map((part, i) =>
    part.hit ? <mark key={i} className="rounded-[3px] bg-amber-300/45 text-inherit dark:bg-amber-400/30">{part.text}</mark> : <span key={i}>{part.text}</span>);
  // A group's project can be what matched (repoSearch), its folder never is: only the part after the folder is marked.
  const groupLabel = (label: string) => {
    const cut = label.indexOf(" / ");
    return cut === -1 ? label : <>{label.slice(0, cut + 3)}{marked(label.slice(cut + 3))}</>;
  };
  let index = -1;
  return (
    <Popover open={open} onOpenChange={(next) => { setOpen(next); if (next) { setQuery(""); setActive(Math.max(flat.findIndex((o) => o.key === value), 0)); } }}>
      <PopoverTrigger asChild disabled={!tree || disabled}>
        <button
          type="button" aria-label={value ? `Repo: ${path} / ${repo}` : "Choose a repo"}
          className={cn(
            "flex h-11 min-w-0 max-w-full items-center gap-2 self-start rounded-full border bg-background px-3.5 text-sm transition-colors motion-reduce:transition-none dark:bg-card",
            "hover:bg-accent focus-visible:border-ring focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-60 data-[state=open]:bg-accent",
            !value && "border-dashed",
          )}
        >
          <FolderGit2 className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="min-w-0 truncate">
            {value
              ? <>{path && <span className="text-muted-foreground">{path} / </span>}<span className="font-medium">{repo}</span></>
              : <span className="text-muted-foreground">{tree ? "Choose a repo" : "Loading repos…"}</span>}
          </span>
          <ChevronDown className="size-3.5 shrink-0 opacity-50" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      {/* As wide as the page's column, so it covers what is under it instead of leaving fragments at its edge. */}
      <PopoverContent align="start" sideOffset={6} collisionPadding={16} className="z-50 w-[min(42rem,calc(100vw-2rem))] overflow-hidden rounded-xl bg-popover p-0 shadow-lg">
        <div className="flex items-center gap-2 border-b px-3">
          <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <input
            autoFocus role="combobox" aria-expanded="true" aria-controls="repo-list" aria-label="Search repos"
            aria-activedescendant={flat.length > 0 ? `repo-opt-${at}` : undefined}
            placeholder="Search repos and projects" value={query}
            className="h-11 min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground sm:text-sm"
            onChange={(e) => { setQuery(e.target.value); setActive(0); }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); setActive(Math.min(at + 1, flat.length - 1)); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setActive(Math.max(at - 1, 0)); }
              else if (e.key === "Enter" && flat[at]) { e.preventDefault(); pick(flat[at].key); }
            }}
          />
        </div>
        <div ref={listRef} id="repo-list" role="listbox" aria-label="Repos" className="max-h-[min(22rem,50dvh)] overflow-y-auto p-1">
          {flat.length === 0 && <p className="px-2 py-3 text-sm text-muted-foreground">No repo matches “{query}”.</p>}
          {sections.map((section) => (
            <div key={section.heading ?? ""} role="group" aria-label={section.heading ?? "Matches"}>
              {section.heading && <p aria-hidden="true" className="mt-1 border-t px-2 pb-0.5 pt-2.5 text-xs font-semibold text-foreground/70">{section.heading}</p>}
              {section.groups.map((g) => (
                <div key={g.label} role="group" aria-label={g.label || section.heading || undefined}>
                  {g.label && <p aria-hidden="true" className="px-2 pb-1 pt-2 text-xs font-medium text-muted-foreground">{groupLabel(g.label)}</p>}
                  {g.items.map((o) => {
                    index += 1;
                    const i = index;
                    return (
                      <div
                        key={o.key} id={`repo-opt-${i}`} data-index={i} role="option" aria-selected={o.key === value}
                        onMouseMove={() => { if (i !== at) setActive(i); }} onClick={() => pick(o.key)}
                        className={cn("flex min-h-9 cursor-pointer items-center gap-2 rounded-md px-2 text-sm", i === at && "bg-accent")}
                      >
                        <Check className={cn("size-4 shrink-0", o.key === value ? "" : "invisible")} aria-hidden="true" />
                        <span className="min-w-0 flex-1 truncate">{o.repo.value === SOLO ? "No repo (claudeSolo)" : marked(o.repo.value)}</span>
                        {o.repo.cloned && <span className="text-xs text-muted-foreground">cloned</span>}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** The agent, as the composer's chip (the same place the chat page has its agent/model chip). */
function AgentMenu({ agent, disabled, onPick }: { agent: AgentName; disabled: boolean; onPick: (a: AgentName) => void }) {
  const profile = AGENT_PROFILES[agent];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <Button
          type="button" variant="ghost" size="sm" aria-label={`Agent: ${profile.label}`} title={`Agent: ${profile.label}`}
          className="h-8 min-w-0 max-w-56 shrink gap-1.5 rounded-full px-2.5 font-medium text-foreground/90 hover:bg-accent hover:text-foreground has-[>svg]:px-2.5 data-[state=open]:bg-accent data-[state=open]:text-foreground"
        >
          <AgentGlyph agent={agent} />
          <span className="truncate">{profile.label}</span>
          <ChevronDown aria-hidden="true" className="size-3.5 opacity-50" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="top" sideOffset={8} collisionPadding={16} className="w-72 max-w-[calc(100vw-2rem)]">
        <DropdownMenuLabel className="text-xs font-medium text-muted-foreground">Agent</DropdownMenuLabel>
        {AGENT_IDS.map((id) => (
          <DropdownMenuItem key={id} onSelect={() => onPick(id)}>
            <Check className={id === agent ? "" : "invisible"} aria-hidden="true" />
            <AgentGlyph agent={id} />
            <span className="flex-1 truncate">{AGENT_PROFILES[id].label}</span>
            {AGENT_PROFILES[id].yolo && <span className="text-xs text-muted-foreground">yolo</span>}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Two quiet choices side by side; a blocked one stays visible, disabled, with its reason as the tooltip. */
function Segmented({ label, options, value, busy, onPick }: {
  label: string; options: { value: string; label: string; disabled: string | null }[]; value: string | null; busy: boolean; onPick: (v: string) => void;
}) {
  return (
    <div role="group" aria-label={label} className="inline-flex items-center gap-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="inline-flex rounded-full border p-0.5">
        {options.map((o) => (
          <button
            key={o.value} type="button" aria-pressed={value === o.value} disabled={busy || o.disabled !== null}
            title={o.disabled ?? undefined} onClick={() => onPick(o.value)}
            className={cn(
              "h-8 rounded-full px-3 text-sm transition-colors motion-reduce:transition-none disabled:cursor-not-allowed disabled:opacity-45",
              "focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
              value === o.value ? "bg-foreground/[0.08] font-medium text-foreground dark:bg-foreground/[0.12]" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}
