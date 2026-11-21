import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, FolderGit2, Search } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Dialog } from "radix-ui";
import { api, type AgentName, type SessionLive, type SessionRuntime, type TreeProject } from "../api";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import {
  AGENT_IDS, AGENT_PROFILES, SOLO, chatRuntimeBlock, defaultAgentFor, instaboxAgentBlock, repoChoices, runningInOtherRuntime,
  continueTakesPrompt, runtimeAfterDefault, runtimeChoice, sendPlan, sessionsFor, tmuxRuntimeBlock,
} from "../newSession";
import { getDefaultRuntime, validateConfig } from "../configEdit";
import { highlight, openIndex, pickKey, repoSearch, searchTerms } from "../repoSearch";
import { openedNotice } from "../sessionsView";
import { useStore } from "../store";
import { Composer } from "../components/chat/Composer";
import { AgentGlyph } from "../components/chat/Switchers";
import { effortLabel, newSessionEffort, newSessionEffortBlock, type SwitchOption } from "../switchView";
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
  // The open "where does your message go" question, answered through its resolver.
  // It holds the session it names, so a store update while it is open cannot change where the answer goes.
  const [asking, setAsking] = useState<{ resolve: (w: Where) => void; session: SessionLive; takesPrompt: boolean } | null>(null);
  const [showAll, setShowAll] = useState(false);
  // The composer's text: what may start with it is decided here (InstaBox and a running terminal take none).
  const [draft, setDraft] = useState("");
  // The effort the first message is sent at (null = the agent's default); offered for Claude chat sessions only.
  const [effort, setEffort] = useState<string | null>(null);
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
    // `replace`: Back from the opened session returns to where New session was opened from, not to this form.
    if (rt === "chat") { navigate(`/s/${encodeURIComponent(id)}`, { replace: true, state: { notice: message } }); return; }
    await refresh();
    if (aliveRef.current) navigate(`/sessions?open=${encodeURIComponent(id)}`, { replace: true, state: { notice: message } });
  }

  // `prompt`: the composer's text, trimmed; empty starts the session without one, as before. A failure is thrown to the
  // caller: from the composer it shows under the box and the text stays (Composer keeps it on a failed send).
  async function startVps(fresh?: boolean, prompt = "", sessionId?: string) {
    if (!folder || !project || !repo || busy || !choice) return;
    setErr(null); setIbxFailed(false); setBusy(true);
    try {
      const r = repo === SOLO
        ? await api.openSolo({ folder, project, agent })
        : await api.openSession({ folder, project, repo, cloneUrl: selected?.cloneUrl, agent, fresh, runtime: choice.runtime, ...(prompt ? { prompt } : {}), ...(prompt && effort !== null ? { effort } : {}), ...(sessionId ? { sessionId } : {}) });
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
    : onIbx ? "InstaBox starts without a message: clear it, or run on the VPS."
    : repo === SOLO ? "claudeSolo starts without a message: clear it, or pick a repo."
    : choice?.runtime === "tmux" && !/\s/.test(prompt) ? "A terminal session's message needs more than one word."
    : choice?.runtime === "tmux" && agent === "antigravity" && prompt.startsWith("-") ? "Antigravity's terminal message can't start with '-'."
    : null;
  // Typed text is new work: it always starts a new session with it. Empty opens the repo's session of this runtime
  // when there is one, as before. Typed text with such a session asks where it goes (askWhere): nothing is picked for
  // the user.
  // The session an empty box opens, named in the summary and sent by id: a running one first.
  const reusable = onIbx ? null : existing.find((s) => s.status === "running") ?? existing[0] ?? null;
  // A new session with text is always asked for fresh: devd's join could otherwise hand it to a session this page does
  // not know about (another tab, a stale store). Continuing names the session by id, as an empty box does.
  const start = async (): Promise<void | false> => {
    const plan = sendPlan(prompt, reusable, onIbx);
    if (plan === "instabox") return startInstabox();
    if (plan === "open") return startVps(false, "", reusable!.id);
    if (plan === "new") return prompt === "" ? startVps() : startVps(true, prompt);
    const target = reusable!, takesPrompt = continueTakes;
    const picked = await new Promise<Where>((resolve) => setAsking({ resolve, session: target, takesPrompt }));
    setAsking(null);
    if (picked === null) return false; // cancelled: the text stays in the box
    return picked === "continue" ? startVps(false, takesPrompt ? prompt : "", target.id) : startVps(true, prompt);
  };
  // A choice the page no longer offers (another agent or interface) goes back to Default, visibly: the chip loses it.
  const effortChoices = onIbx || repo === SOLO ? null : newSessionEffort(agent, choice?.runtime ?? null, effort);
  useEffect(() => { if (effortChoices === null && effort !== null) setEffort(null); }, [effortChoices, effort]);
  const effortBlock = newSessionEffortBlock(prompt, effort);
  const startLabel = ibxFailed && onIbx ? "Try again" : onIbx ? "Start on InstaBox" : reusable && prompt === "" ? "Open existing" : "Start session";
  const canStart = !!repo && !busy && !!choice && textBlock === null && effortBlock === null;
  // Continuing takes the message only where devd can deliver it: a running terminal's agent has already started.
  const continueTakes = reusable !== null && !!choice && continueTakesPrompt(reusable, choice.runtime);

  const where = onIbx ? "on InstaBox" : "on the VPS";
  const what = choice?.runtime === "chat" ? "chat" : "terminal";
  const opensExisting = reusable !== null && prompt === "";
  // A repo in the old layout (shared working directory) cannot give another session its own worktree or branch — only
  // its own container. Two agents on one git index must be announced up front, not discovered from the behavior.
  const shares = reusable && !opensExisting && selected?.cloned && !selected.bare ? ", sharing this repo's files and branch" : "";
  const summary = !repo ? null
    : !choice ? "Pick an interface: the default runtime is not loaded."
    : opensExisting ? `Opens ${reusable.id} (${what}, ${reusable.status}).`
    : reusable && prompt !== "" && textBlock === null ? `Asks whether your message continues ${reusable.id} or starts a new session.`
    : `Starts a new ${what} session ${where}${prompt !== "" && textBlock === null ? " with your message" : ""}${shares}.`;
  // One line under the box: progress, then an error, then a warning, then what the send does.
  const line = busy && step ? { text: `${JOB_STEP_LABEL[step] ?? step}…`, tone: "status" as const }
    : err ? { text: err, tone: "error" as const }
    : textBlock ? { text: textBlock, tone: "warn" as const }
    : effortBlock ? { text: effortBlock, tone: "warn" as const }
    : repo && choice?.notice ? { text: choice.notice, tone: "warn" as const }
    : !tree ? { text: "Loading workspaces…", tone: "status" as const }
    : summary ? { text: summary, tone: "status" as const } : null;

  return (
    <div className="mx-auto flex w-full max-w-[42rem] flex-col gap-4 pt-2 sm:pt-[12vh]">
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
        onSend={start}
        controls={<>
          <OptionsMenu
            disabled={busy}
            runtime={choice?.runtime ?? null} host={onIbx ? "instabox" : "vps"}
            chatDisabled={chatDisabled} tmuxDisabled={tmuxDisabled} ibxDisabled={ibxDisabled}
            busyVps={placement?.reason ?? null}
            onRuntime={setRuntime} onHost={setHost}
          />
          <AgentMenu agent={agent} disabled={!repo || busy} onPick={setAgent} effort={effort} effortChoices={effortChoices} onEffort={setEffort} />
        </>}
      />

      <div className="flex flex-col gap-3 px-1">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
          {line && (
            <p role={line.tone === "error" ? "alert" : "status"} className={cn(
              line.tone === "error" ? "text-destructive" : line.tone === "warn" ? "text-amber-700 dark:text-amber-300" : "text-muted-foreground",
            )}>{line.text}</p>
          )}
          {reusable && !busy && prompt === "" && <InlineAction onClick={() => report(startVps(true))}>Create another</InlineAction>}
          {ibxFailed && !busy && <InlineAction onClick={() => { setHost("vps"); report(startVps()); }}>Open on VPS</InlineAction>}
        </div>

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
                  <li key={s.id} className="flex min-h-9 items-center gap-2 text-sm">
                    <span className={cn("size-1.5 shrink-0 rounded-full", s.status === "running" ? "bg-emerald-500" : "bg-muted-foreground/40")} aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate">
                      <span className="font-mono text-[13px]">{s.id}</span>
                      <span className="text-muted-foreground"> · {s.runtime === "chat" ? "chat" : "terminal"} · {s.status}</span>
                    </span>
                    {runningOther.includes(s) && <Button type="button" size="sm" variant="ghost" className="shrink-0" disabled={busy} onClick={() => openRunning(s)}>Open</Button>}
                  </li>
                ))}
              </ul>
            )}
            {showAll && runningOther.length > 0 && <Hint>Starting here creates a {what} session next to the running {runningOther[0].runtime === "chat" ? "chat" : "terminal"} one.</Hint>}
          </section>
        )}
      </div>
      {asking && <AskWhere session={asking.session} what={what} takesPrompt={asking.takesPrompt} onPick={asking.resolve} />}
    </div>
  );
}

type Where = "continue" | "new" | null;

/** Typed text with an existing session of the repo: where it goes is asked, never guessed. Two equal choices, nothing
 *  focused at first (Enter does not pick one), Escape cancels and the text stays in the box. */
function AskWhere({ session, what, takesPrompt, onPick }: {
  session: SessionLive; what: string; takesPrompt: boolean; onPick: (w: Where) => void;
}) {
  const content = useRef<HTMLDivElement>(null);
  // It unmounts when answered, so it hands focus back itself, always to the message box where the text stays: the
  // element focused before it opened can be the send button, disabled by then.
  useEffect(() => () => { document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')?.focus(); }, []);
  const choice = "flex min-h-11 w-full flex-col items-start gap-0.5 rounded-lg border px-3.5 py-2.5 text-left text-sm transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 motion-reduce:transition-none";
  return (
    <Dialog.Root open onOpenChange={(next) => { if (!next) onPick(null); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/45" />
        <Dialog.Content
          ref={content} tabIndex={-1}
          className="fixed left-1/2 top-1/2 z-50 w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border bg-background p-5 shadow-xl outline-none sm:p-6"
          onOpenAutoFocus={(e) => { e.preventDefault(); content.current?.focus(); }}
        >
          <Dialog.Title className="text-lg font-semibold tracking-tight">Where should your message go?</Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-muted-foreground">
            This repo already has a {what} session, {session.id} ({session.status}).
          </Dialog.Description>
          <div className="mt-5 flex flex-col gap-2">
            <button type="button" className={choice} onClick={() => onPick("continue")}>
              <span className="font-medium">Continue <span className="font-mono text-[13px]">{session.id}</span></span>
              <span className="text-xs text-muted-foreground">{takesPrompt
                ? "Your message goes to that session."
                : `Opens it without your message: ${session.host === "instabox" ? "an InstaBox session takes no message" : "its agent is already running, so the message would not reach it"}.`}</span>
            </button>
            <button type="button" className={choice} onClick={() => onPick("new")}>
              <span className="font-medium">New session</span>
              <span className="text-xs text-muted-foreground">Starts another {what} session with your message.</span>
            </button>
          </div>
          <p className="mt-4 text-xs text-muted-foreground">Esc cancels; your message stays in the box.</p>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
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
    <Popover open={open} onOpenChange={(next) => {
      setOpen(next);
      if (!next) return;
      setQuery("");
      setActive(openIndex(tree ?? [], value));
    }}>
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
              else if (e.key === "Home") { e.preventDefault(); setActive(0); }
              else if (e.key === "End") { e.preventDefault(); setActive(Math.max(flat.length - 1, 0)); }
              else if (e.key === "Enter" && flat[at]) { e.preventDefault(); pick(flat[at].key); }
            }}
          />
        </div>
        <div ref={listRef} id="repo-list" role="listbox" aria-label="Repos" className="max-h-[min(22rem,50dvh)] overflow-y-auto p-1">
          {flat.length === 0 && <p className="px-2 py-3 text-sm text-muted-foreground">No repo matches “{query}”.</p>}
          {/* One level of groups (a listbox allows no nesting): a folder section's heading is part of each group's name. */}
          {sections.map((section) => (
            <div key={section.heading ?? ""}>
              {section.heading && <p aria-hidden="true" className="mt-1 border-t px-2 pb-0.5 pt-2.5 text-xs font-semibold text-foreground/70">{section.heading}</p>}
              {section.groups.map((g) => (
                <div key={g.label} role="group" aria-label={[section.heading, g.label].filter(Boolean).join(" / ")}>
                  {g.label && <p aria-hidden="true" className="px-2 pb-1 pt-2 text-xs font-medium text-muted-foreground">{groupLabel(g.label)}</p>}
                  {g.items.map((o) => {
                    index += 1;
                    const i = index;
                    return (
                      <div
                        key={o.key} id={`repo-opt-${i}`} data-index={i} role="option" aria-selected={o.key === value}
                        onMouseMove={() => { if (i !== at) setActive(i); }} onClick={() => pick(o.key)}
                        className={cn("flex min-h-9 cursor-pointer items-center gap-2 rounded-md px-2 text-sm max-sm:min-h-11", i === at && "bg-accent")}
                      >
                        <span className="min-w-0 flex-1 truncate">{o.repo.value === SOLO ? "No repo (claudeSolo)" : marked(o.repo.value)}</span>
                        {o.repo.cloned && <span className="text-xs text-muted-foreground">cloned</span>}
                        {o.key === value && <Check className="size-4 shrink-0" aria-hidden="true" />}
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

/** The agent, as the composer's chip (the same place the chat page has its agent/model chip), with the effort the first
 *  message is sent at when one is offered: "Claude · High", its levels in the menu's Effort section. One chip, so the
 *  toolbar keeps room on a phone. */
function AgentMenu({ agent, disabled, onPick, effort, effortChoices, onEffort }: {
  agent: AgentName; disabled: boolean; onPick: (a: AgentName) => void;
  effort: string | null; effortChoices: SwitchOption[] | null; onEffort: (e: string | null) => void;
}) {
  const profile = AGENT_PROFILES[agent];
  const level = effortChoices !== null && effort !== null ? effortLabel(effort) : null;
  const named = `Agent: ${profile.label}${level ? `, effort ${level}` : ""}`;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <Button
          type="button" variant="ghost" size="sm" aria-label={named} title={named}
          className="h-8 max-w-56 shrink-0 gap-1.5 rounded-full px-2.5 font-medium text-foreground/90 hover:bg-accent hover:text-foreground has-[>svg]:px-2.5 data-[state=open]:bg-accent data-[state=open]:text-foreground"
        >
          <AgentGlyph agent={agent} />
          {/* A phone shows the short name, or the chosen level instead (the glyph names the agent), so the options chip
              beside it keeps its whole label. */}
          <span className="truncate sm:hidden">{level ?? profile.short}</span>
          <span className="truncate max-sm:hidden">{profile.label}</span>
          {level && <span className="shrink-0 max-sm:hidden"><span className="text-muted-foreground">· </span><span className="font-semibold">{level}</span></span>}
          <ChevronDown aria-hidden="true" className="size-3.5 opacity-50" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="bottom" sideOffset={8} collisionPadding={16} className="w-[calc(100vw-2rem)] bg-popover sm:w-72">
        <DropdownMenuLabel className="text-xs font-medium text-muted-foreground">Agent</DropdownMenuLabel>
        {AGENT_IDS.map((id) => (
          <DropdownMenuItem key={id} onSelect={() => onPick(id)} className="max-sm:min-h-11">
            <Check className={id === agent ? "" : "invisible"} aria-hidden="true" />
            <AgentGlyph agent={id} />
            <span className="flex-1 truncate">{AGENT_PROFILES[id].label}</span>
            {AGENT_PROFILES[id].yolo && <span className="text-xs text-muted-foreground">yolo</span>}
          </DropdownMenuItem>
        ))}
        {effortChoices !== null && <>
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-xs font-medium text-muted-foreground">Effort</DropdownMenuLabel>
          {effortChoices.map((o) => (
            <DropdownMenuItem key={o.value} onSelect={() => onEffort(o.value === "" ? null : o.value)} className="max-sm:min-h-11">
              <Check className={o.current ? "" : "invisible"} aria-hidden="true" />
              <span className="flex-1 truncate">{o.label}</span>
            </DropdownMenuItem>
          ))}
          <p className="px-2 pb-1.5 text-xs text-muted-foreground">Set with your first message, which checks it against the model.</p>
        </>}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A secondary action next to the line under the box: quieter than send, a real button. */
function InlineAction({ children, disabled = false, onClick }: { children: ReactNode; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      type="button" disabled={disabled} onClick={onClick}
      className="min-h-8 rounded-sm text-left text-muted-foreground underline decoration-muted-foreground/40 underline-offset-4 hover:text-foreground hover:decoration-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 max-sm:min-h-11"
    >
      {children}
    </button>
  );
}

/** Interface and host in one chip of the composer's toolbar ("Chat · VPS"); a blocked choice stays listed, disabled,
 *  with its reason, and each choice says what it means. */
function OptionsMenu({ disabled, runtime, host, chatDisabled, tmuxDisabled, ibxDisabled, busyVps, onRuntime, onHost }: {
  disabled: boolean; runtime: SessionRuntime | null; host: "vps" | "instabox";
  chatDisabled: string | null; tmuxDisabled: string | null; ibxDisabled: string | null; busyVps: string | null;
  onRuntime: (r: SessionRuntime) => void; onHost: (h: "vps" | "instabox") => void;
}) {
  const runtimeLabel = runtime === null ? "…" : runtime === "chat" ? "Chat" : "Terminal";
  const hostLabel = host === "instabox" ? "InstaBox" : "VPS";
  const label = `${runtimeLabel} · ${hostLabel}`;
  const item = (key: string, title: string, current: boolean, blocked: string | null, detail: string, pick: () => void) => (
    <DropdownMenuItem key={key} disabled={blocked !== null} onSelect={pick} className="items-start data-[disabled]:opacity-100 max-sm:min-h-11">
      <Check className={cn("mt-0.5", current ? "" : "invisible")} aria-hidden="true" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className={blocked ? "opacity-50" : undefined}>{title}</span>
        <span className="text-xs text-muted-foreground">{blocked ?? detail}</span>
      </span>
    </DropdownMenuItem>
  );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <Button
          type="button" variant="ghost" size="sm" aria-label={`Session options: ${label}`} title={`Session options: ${label}`}
          className="h-8 min-w-0 shrink gap-1 rounded-full px-2.5 font-medium text-foreground/80 hover:bg-accent hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground"
        >
          <span className="truncate">{label}</span>
          <ChevronDown aria-hidden="true" className="size-3.5 opacity-50" />
        </Button>
      </DropdownMenuTrigger>
      {/* Downward, under the box: never over the repo pill above it. A phone gets the composer's full width. */}
      <DropdownMenuContent align="end" side="bottom" sideOffset={8} collisionPadding={16} className="w-[calc(100vw-2rem)] bg-popover sm:w-80">
        <DropdownMenuLabel className="text-xs font-medium text-muted-foreground">Interface</DropdownMenuLabel>
        {item("chat", "Chat", runtime === "chat", chatDisabled, "The agent runs behind a chat view; its terminal stays available as a tab.", () => onRuntime("chat"))}
        {item("tmux", "Terminal", runtime === "tmux", tmuxDisabled, "The agent runs in a tmux terminal.", () => onRuntime("tmux"))}
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs font-medium text-muted-foreground">Where it runs</DropdownMenuLabel>
        {item("vps", "VPS", host === "vps", null, busyVps ? `Busy right now (${busyVps}).` : "The shared server, with review, prod-db, Finder and previews.", () => onHost("vps"))}
        {item("instabox", "InstaBox", host === "instabox", ibxDisabled,
          `${busyVps ? "Recommended while the VPS is busy. " : ""}A new session on its own machine with a fresh clone. No review, prod-db, Finder or previews; the agent's browser is visible under Desktop.`,
          () => onHost("instabox"))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
