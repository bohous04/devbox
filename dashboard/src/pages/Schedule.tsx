import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { FormDialog } from "../components/FormDialog";
import { api, type Schedule, type TreeProject } from "../api";
import { ActionButton, AppPage, ConfirmButton, EmptyState, RowsSkeleton, Section } from "../components/primitives";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { agoLabel } from "../format";
import { folderChoices, projectChoices, repoChoices, soleProject } from "../newSession";

const selectCls = "h-11 w-full rounded-md border bg-background px-2 text-sm text-foreground disabled:cursor-not-allowed disabled:opacity-50";
const textareaCls = "w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";

function NewSchedule({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => Promise<void> }) {
  const [tree, setTree] = useState<TreeProject[] | null>(null);
  const [folder, setFolder] = useState(""); const [project, setProject] = useState(""); const [repo, setRepo] = useState("");
  const [name, setName] = useState(""); const [cron, setCron] = useState("0 3 * * *"); const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);

  useEffect(() => { if (open && tree === null) api.tree().then(setTree).catch((e) => setErr((e as Error).message)); }, [open, tree]);
  useEffect(() => { if (tree && folder) { const sp = soleProject(tree, folder); if (sp) setProject(sp); } }, [folder, tree]);
  const folders = tree ? folderChoices(tree) : [];
  const projects = tree && folder ? projectChoices(tree, folder) : [];
  const repos = tree && folder && project ? repoChoices(tree, folder, project).filter((r) => r.cloneUrl) : [];

  async function create() {
    const choice = repos.find((r) => r.value === repo);
    if (busy || !name.trim() || !cron.trim() || !folder || !project || !repo || !choice?.cloneUrl || !prompt.trim()) return;
    setBusy(true); setErr(null);
    try {
      await api.createSchedule({ name: name.trim(), cron: cron.trim(), folder, project, repo, cloneUrl: choice.cloneUrl, prompt: prompt.trim() });
      setName(""); setPrompt(""); setRepo(""); await onCreated(); onClose();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <FormDialog open={open} onOpenChange={(next) => { if (!next) onClose(); }} title="New schedule" description="Run a prompt automatically in a repository on a recurring schedule." busy={busy}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void create(); }}>
        {!tree && !err && <p role="status" className="text-sm text-muted-foreground">Loading repositories…</p>}
        <label className="grid gap-1.5 text-sm font-medium">Name<Input required placeholder="Nightly dependency update" value={name} onChange={(e) => setName(e.target.value)} /></label>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="grid gap-1.5 text-sm font-medium">Folder<select className={selectCls} value={folder} disabled={!tree || busy} required onChange={(e) => { setFolder(e.target.value); setProject(""); setRepo(""); }}><option value="">Choose folder</option>{folders.map((f) => <option key={f} value={f}>{f}</option>)}</select></label>
          <label className="grid gap-1.5 text-sm font-medium">Project<select className={selectCls} value={project} required disabled={!folder || busy} onChange={(e) => { setProject(e.target.value); setRepo(""); }}><option value="">Choose project</option>{projects.map((p) => <option key={p} value={p}>{p}</option>)}</select></label>
        </div>
        <label className="grid gap-1.5 text-sm font-medium">Repository<select className={selectCls} value={repo} required disabled={!project || busy} onChange={(e) => setRepo(e.target.value)}><option value="">Choose repository</option>{repos.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}</select></label>
        <label className="grid gap-1.5 text-sm font-medium">Cron expression<Input required className="font-mono" value={cron} onChange={(e) => setCron(e.target.value)} aria-describedby="cron-help" /></label>
        <p id="cron-help" className="text-xs text-muted-foreground">Minute · hour · day · month · weekday. Example: 0 3 * * * runs daily at 03:00 (server time).</p>
        <label className="grid gap-1.5 text-sm font-medium">Prompt<textarea className={textareaCls} required rows={4} placeholder="Describe the work to complete…" value={prompt} onChange={(e) => setPrompt(e.target.value)} /></label>
        {err && <p role="alert" className="text-sm text-destructive">{err}</p>}
        <div className="flex justify-end gap-2 border-t pt-4"><Button type="button" variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button><Button type="submit" disabled={busy || !name.trim() || !repo || !prompt.trim()}>{busy ? "Saving…" : "Create schedule"}</Button></div>
      </form>
    </FormDialog>
  );
}

export function Schedule() {
  const [newOpen, setNewOpen] = useState(false);
  const [list, setList] = useState<Schedule[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  async function load() { try { setList(await api.schedules()); setErr(null); } catch (e) { setErr((e as Error).message); } }
  useEffect(() => { load(); }, []);

  async function toggle(s: Schedule) { await api.updateSchedule(s.id, { enabled: s.enabled === 1 ? 0 : 1 }); await load(); }
  // "Important" = Pushover EMERGENCY (priority 2: rings every minute for up to an hour until
  // you acknowledge it) for that session's notifications — i.e. when the agent gets stuck or finishes
  // its work. Starting the run itself is never loud. There used to be no toggle here at all,
  // even though schedules were created enabled, so the morning cron woke the phone and it could not be turned off.
  async function toggleImportant(s: Schedule) { await api.updateSchedule(s.id, { important: s.important === 1 ? 0 : 1 }); await load(); }
  async function run(s: Schedule) { await api.runSchedule(s.id); }
  async function remove(s: Schedule) { await api.deleteSchedule(s.id); await load(); }

  return (
    <AppPage title="Schedules" sub="Recurring tasks, prompts and their next steps." actions={<Button className="min-h-11" onClick={() => setNewOpen(true)}><Plus className="size-4" />New schedule</Button>}>
      <NewSchedule open={newOpen} onClose={() => setNewOpen(false)} onCreated={load} />
      <Section label="Schedules" meta={list ? `${list.length}` : "loading…"}>
        {err && <p className="mb-3 text-sm font-medium text-destructive">{err}</p>}
        {!list && !err && <RowsSkeleton rows={3} />}
        {list && list.length === 0 && <EmptyState title="No schedules" hint="Add a scheduled run with the button above." />}
        {list && list.length > 0 && (
          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/30">
                    <TableHead>Name</TableHead>
                    <TableHead>Cron</TableHead>
                    <TableHead>Last run</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Alerts</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {list.map((s) => (
                    <TableRow key={s.id} className={cn(!s.enabled && "opacity-60")}>
                      <TableCell className="min-w-48 max-w-xs">
                        <div className="font-medium">{s.name}</div>
                        <div className="text-xs text-muted-foreground">{s.project}/{s.repo}</div>
                        <div className="mt-0.5 truncate text-xs text-muted-foreground" title={s.prompt}>
                          {s.prompt.slice(0, 160)}{s.prompt.length > 160 ? "…" : ""}
                        </div>
                      </TableCell>
                      <TableCell><code className="font-mono text-xs">{s.cron}</code></TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {s.last_run_at ? agoLabel(Date.now() - s.last_run_at) : "never"}
                      </TableCell>
                      <TableCell>
                        <ActionButton variant={s.enabled ? "secondary" : "outline"} size="sm" aria-pressed={s.enabled === 1} onError={setErr} onAction={() => toggle(s)}>{s.enabled ? "Enabled" : "Paused"}</ActionButton>
                      </TableCell>
                      <TableCell>
                        <ActionButton variant="ghost" size="sm" aria-pressed={s.important === 1} onError={setErr}
                          title={s.important ? "Emergency push repeats until acknowledged" : "Normal push on completion or blocking"}
                          onAction={() => toggleImportant(s)}>{s.important ? "Emergency" : "Normal"}</ActionButton>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-2 [&_button]:min-h-11">
                          <ActionButton variant="outline" size="sm" onError={setErr} onAction={() => run(s)}>Run now</ActionButton>
                          <ConfirmButton
                            variant="ghost"
                            size="sm"
                            confirmLabel="Delete schedule?"
                            onError={setErr}
                            onConfirm={() => remove(s)}
                          >
                            Delete
                          </ConfirmButton>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}
      </Section>
    </AppPage>
  );
}
