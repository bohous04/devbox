#!/usr/bin/env bun
import { confirm, isCancel, log, outro, select, spinner, type Option } from "@clack/prompts";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { AGENT_IDS, agentNameFor, conversationCarries, isAgentName, specFor } from "../../devd/src/agents";
import { sanitizeSessionName, type AgentName } from "../../devd/src/db";
import { sh } from "./sh";
import type { TreeProject } from "../../devd/src/tree";
import { ApiClient, type SessionInfo, type WriteRow } from "./api";
import { agentLabel, altCfg, buildExecArgv, probeArgv, runInteractive, sessionPickerOptions, tmuxCommand, withSessionName } from "./attach";
import { parseProbe } from "../../devd/src/tmux";
import { loadCliConfig, type CliConfig } from "./config";
import { runDoctor } from "./doctor";
import { clearScreen, endEffect, formatDoctor, formatOpenProgress, formatPorts, formatSessions, sessionLabel } from "./format";
import { runLocal } from "./local";
import { promptName, sessionManager } from "./manager";
import { agentSwitchSummary, exitMenuOptions, type ExitAction } from "./manager-view";
import { agentFlag, agentOptions, folderOptions, freshLabel, gistOutcome, hostFlag, NEW_SOLO, projectOptions, repoOptions, runningSolosIn, shouldAskAgent, soloActionOptions, soloMenuOptions, stripAgentFlags, stripHostFlags } from "./picker";
import type { IbxStatus } from "../../devd/src/instabox/reconcile";
import type { BaseStep } from "../../devd/src/instabox/base";
import { attachLoop } from "./reconnect";
import { fileLastAttached, fileRecents, flattenTree, matchSessions, resolveQuery, sortByRecent, type Target } from "./resolve";
import { newestRecoveryRecords, ownerAlive, recoveryLaunchConfig, safeTmuxSession, sameRecoveryServer, sameRecoveryTarget, terminalRecoveryStore, waitForSavedSession, warpPaneId } from "./recovery";
import { detectedWarpGrokSupport } from "./warp";
import { snapshotWarpConnectionPlan } from "./recoverySnapshot";
import { readProcessIdentity } from "./recoveryOwner";

export interface Deps { cfg: CliConfig; api: ApiClient }

const recents = fileRecents(join(homedir(), ".config", "devbox-cli", "recents.json"));
const lastAttached = fileLastAttached(join(homedir(), ".config", "devbox-cli", "attached.json"));

const USAGE = `Usage:
  dev                     manage running sessions (preview/attach/stop + new)
  dev <project>/<repo>    open a session (attach to a running one, or start another)
  dev --agent <id> <target>   start it with a given agent profile
                              (claude | claude-gpt | claude-grok | claude-gemini | claude-openrouter | codex | grok | antigravity)
  dev --codex / --claude      shortcuts for the two most common ones
  dev --instabox <target>     start a NEW session on an InstaBox machine (overflow)
  dev instabox status         InstaBox capacity, base snapshot, orphaned machines
  dev instabox rebuild-base   rebuild the InstaBox base snapshot from the devbox image
  dev local               run a harness locally in the current folder (picker)
  dev ls                  session overview
  dev stop <target>|--all  stop container(s)
  dev end <target>        end session
  dev important <target> [on|off]  loud phone alert (done/blocked/stuck)
  dev ports [target]      port mapping
  dev attach <target> [tmux]  attach the exact running session (default: main)
  dev resume              reconnect this restored Warp pane
  dev recover [--tabs|--snapshot]  list, reopen, or save existing Warp connections
  dev switch <target>     use a fresher Anthropic account and resume the same conversation
  dev doctor              check environment
  dev clone <folder>|--all  clone missing repos
  dev backup [file]       download a backup (claude-home, secrets, db)
  dev restore <file>      upload and restore a backup
  dev prod-writes [--review]  pending prod writes (--review = walk through and approve)
  dev prod-write <id>     proposal detail + impact preview
  dev prod-approve <id>   approve and execute the prod write
  dev prod-reject <id>    reject the prod write`;

// Target of the `stop`/`end`/`important`/`ports`/`attach`/`switch` commands. `project/repo` can
// match SEVERAL sessions (a second session of the same repo), and silently taking the first one has been,
// since `end()` deletes session files, silent data loss: it would delete the work in progress of the one
// the user did not mean. So on a TTY the user picks; off a TTY (automation, notification
// click) it fails loudly listing the ids — it never guesses. An exact `id` stays
// unambiguous with unchanged behavior (see matchSessions).
async function findSession(deps: Deps, query: string): Promise<SessionInfo> {
  const matches = matchSessions(await deps.api.sessions(), query);
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) throw new Error(`Session "${query}" doesn't exist — try \`dev ls\`.`);
  if (!(process.stdin.isTTY && process.stdout.isTTY)) {
    throw new Error(`"${query}" matches ${matches.length} sessions (${matches.map((s) => s.id).join(", ")}) — repeat the command with the exact id.`);
  }
  const picked = await selectVal<string>(`Which session? (${query})`, matches.map((s) => ({
    value: s.id,
    label: s.id,
    hint: [s.status, s.name?.trim() || null, s.worktree ? "own worktree" : "shared workdir"].filter(Boolean).join(" · "),
  })));
  if (picked === undefined) throw new Error("Cancelled — no session picked.");
  return matches.find((s) => s.id === picked)!;
}

async function reviewProdWrites(deps: Deps, pending: WriteRow[]): Promise<number> {
  if (pending.length === 0) { console.log("No pending prod writes."); return 0; }
  for (const w of pending) {
    log.message(`#${w.id} [${w.db}] ${w.session_id ?? ""}\n${w.sql}`);
    try { log.info(`impact preview: ${(await deps.api.prodWritePreview(w.id)).note}`); }
    catch (e) { log.warn(`preview failed: ${(e as Error).message}`); }
    const ok = await confirm({ message: `Approve write #${w.id}?` });
    if (isCancel(ok)) { log.info("aborted"); break; }
    if (ok) log.success(`✅ ${(await deps.api.prodWriteApprove(w.id)).note}`);
    else { await deps.api.prodWriteReject(w.id); log.info("❌ rejected"); }
  }
  return 0;
}

export async function run(rawArgv: string[], deps: Deps): Promise<number> {
  // Validate right at the start: a nonsensical --agent value must not silently fall through to
  // the default profile (a silently launched wrong model is worse than a loud refusal).
  const ai = rawArgv.indexOf("--agent");
  if (ai >= 0 && !isAgentName(rawArgv[ai + 1])) {
    console.error(`Error: unknown agent "${rawArgv[ai + 1] ?? ""}". Use one of: ${AGENT_IDS.join(", ")}`);
    return 2;
  }
  const forcedAgent = agentFlag(rawArgv);
  const host = hostFlag(rawArgv);
  const argv = stripHostFlags(stripAgentFlags(rawArgv));
  const [cmd, ...rest] = argv;
  try {
    switch (cmd) {
      case undefined:
        return await sessionManager(deps, forcedAgent);
      case "--version": {
        const pkg = (await import("../package.json")) as { version?: string };
        console.log(pkg.version ?? "0.0.0");
        return 0;
      }
      case "local":
        return await runLocal(deps);
      case "ls":
        console.log(formatSessions(await deps.api.sessions({ tmux: true })));
        return 0;
      case "stop": {
        if (rest[0] === "--all") {
          const running = (await deps.api.sessions()).filter((s) => s.status === "running");
          for (const s of running) { await deps.api.stop(s.id); console.log(`Stopped: ${s.id}`); }
          if (running.length === 0) console.log("Nothing is running.");
          return 0;
        }
        if (!rest[0]) { console.error(USAGE); return 2; }
        const s = await findSession(deps, rest[0]);
        await deps.api.stop(s.id);
        console.log(`Stopped: ${s.id}`);
        return 0;
      }
      case "end": {
        if (!rest[0]) { console.error(USAGE); return 2; }
        const s = await findSession(deps, rest[0]);
        if (s.solo) {
          if (process.stdin.isTTY && process.stdout.isTTY) return await endSoloInteractive(deps, s);
          await deps.api.end(s.id, "keep");
          console.log(`Kept — workspace stays in ${s.folder}/${s.project}/${s.repo}, session ended.`);
          return 0;
        }
        const r = await deps.api.end(s.id);
        if (r?.pending) console.log(`Ending: ${s.id} — backup in progress, finishes in the background (you'll get a notification).`);
        else console.log(`Ended: ${s.id} — ${endEffect(!!s.worktree)}`);
        return 0;
      }
      case "important": {
        if (!rest[0]) { console.error(USAGE); return 2; }
        const s = await findSession(deps, rest[0]);
        const arg = rest[1];
        const on = arg === undefined ? s.important !== 1 : /^(on|1|true|ano|zap)$/i.test(arg);
        await deps.api.important(s.id, on);
        // Id, not project/repo: with two sessions of the same repo the output would not say WHICH one
        // was toggled — and this is the toggle for emergency alerts to the phone. The id contains
        // project/repo anyway, so nothing is lost.
        console.log(`${s.id}: important ${on ? "ON" : "off"}`);
        return 0;
      }
      case "ports": {
        const host = deps.cfg.sshHost ?? "localhost";
        const sessions = await deps.api.sessions();
        const targets = rest[0] ? [await findSession(deps, rest[0])] : sessions.filter((s) => s.status === "running");
        if (targets.length === 0) { console.log("Nothing is running."); return 0; }
        for (const s of targets) {
          // Id here too: `dev ports` without a target lists all running ones and two sessions of the same
          // repo would get two IDENTICAL headers over different ports.
          console.log(`${s.id}:`);
          console.log(formatPorts(s, host));
        }
        return 0;
      }
      case "attach": {
        if (!rest[0]) { console.error(USAGE); return 2; }
        const tmuxSession = rest[1] ?? "main";
        if (rest.length > 2 || !safeTmuxSession(tmuxSession)) throw new Error("Invalid tmux session name");
        const s = await findSession(deps, rest[0]);
        if (s.status !== "running") {
          console.error(`Error: session ${s.id} isn't running — open it via \`dev ${s.project}/${s.repo}\`.`);
          return 1;
        }
        // Deterministic mirror without the interactive picker — also called by a notification
        // click (Warp launch config), where nothing may wait for the keyboard.
        return await runExitAware(deps, s.container, tmuxSession);
      }
      case "resume": {
        const automatic = rest.length === 1 && rest[0] === "--auto";
        const explicitPane = rest.length === 2 && rest[0] === "--pane" ? rest[1] : undefined;
        if (rest.length && !automatic && !explicitPane) { console.error(USAGE); return 2; }
        const currentPane = warpPaneId();
        const paneId = explicitPane ?? currentPane;
        const store = terminalRecoveryStore();
        const saved = paneId ? store.read(paneId) : undefined;
        if (!saved) {
          if (automatic) return 0;
          throw new Error("No saved connection for this Warp pane — use `dev recover`.");
        }
        if (!currentPane || !(process.stdin.isTTY && process.stdout.isTTY)) throw new Error("Resume must run in an interactive Warp pane.");
        if (!sameRecoveryServer(saved, deps.cfg)) throw new Error("Saved terminal belongs to a different devd server; restore its CLI configuration first.");
        const allSaved = store.list();
        const newest = newestRecoveryRecords(allSaved).find((r) => sameRecoveryTarget(r, saved));
        const active = allSaved.some((r) => sameRecoveryTarget(r, saved) && r.ownerPid !== process.pid && ownerAlive(r));
        if (active || (automatic && newest?.paneId !== saved.paneId)) {
          if (automatic) return 0;
          throw new Error("This session already has a live connection; no duplicate terminal was opened.");
        }
        // Resume cannot silently start a fresh/default agent when an exact tmux
        // target is missing. Server recovery owns restoring its conversation.
        console.log(`Reconnecting ${saved.label} · ${saved.tmuxSession}…`);
        const s = await waitForSavedSession(saved, {
          sessions: () => deps.api.sessions({ tmux: true, timeoutMs: 10_000 }),
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        });
        return await runExitAware(deps, s.container, saved.tmuxSession, true,
          currentPane && currentPane !== saved.paneId ? saved.paneId : undefined);
      }
      case "recover": {
        const snapshotPlanOnly = rest.length === 2 && rest[0] === "--snapshot" && rest[1] === "--dry-run";
        if ((!snapshotPlanOnly && rest.length > 1) || (rest.length && !["--tabs", "--snapshot"].includes(rest[0]))) { console.error(USAGE); return 2; }
        if (rest[0] === "--snapshot") {
          if (process.platform !== "darwin") throw new Error("Warp connection migration is supported on macOS.");
          const plan = snapshotWarpConnectionPlan(await deps.api.sessions(), deps.cfg);
          const store = terminalRecoveryStore();
          let saved = 0;
          for (const record of plan.records) {
            const existing = store.read(record.paneId);
            if (existing && existing.ownerPid !== record.ownerPid) {
              if (ownerAlive(existing)) continue;
            }
            if (!snapshotPlanOnly) store.write(record);
            saved++;
            console.log(`${record.sessionId} · ${record.tmuxSession}`);
          }
          const skipped = plan.warpCliProcesses - saved;
          console.log(`${snapshotPlanOnly ? "Matched" : "Saved"} ${saved}/${plan.warpCliProcesses} live Warp dev connections; ${skipped} skipped (ambiguous, unsupported, or owned by another live process).`);
          if (skipped) console.log("For skipped panes, detach and run `dev attach <exact-session-id> <tmux-name>` before updating Warp.");
          return skipped ? 1 : 0;
        }
        const records = terminalRecoveryStore().list().filter((r) => sameRecoveryServer(r, deps.cfg));
        if (!records.length) { console.log("No saved Warp connections."); return 0; }
        if (!rest.length) {
          for (const r of records) console.log(`${r.sessionId} · ${r.tmuxSession} · ${r.label}`);
          console.log("Warp restores the original windows and panes; `dev resume` reconnects each pane. `dev recover --tabs` opens a replacement window.");
          return 0;
        }
        if (process.platform !== "darwin") throw new Error("Opening Warp recovery tabs is supported on macOS.");
        // A live owner can be an active attach or the native startup hook. Never
        // detach it by opening a second tmux client. Boot/process identity keeps
        // a reused PID after restart from being mistaken for that owner.
        const pending = newestRecoveryRecords(records).filter((r) =>
          !records.some((other) => sameRecoveryTarget(other, r) && ownerAlive(other)));
        if (!pending.length) { console.log("Saved terminals already have live connections."); return 0; }
        const launchDir = join(homedir(), ".warp", "launch_configurations");
        const name = `devbox-recovery-${process.pid}-${Date.now()}.yaml`;
        mkdirSync(launchDir, { recursive: true });
        writeFileSync(join(launchDir, name), recoveryLaunchConfig(pending, homedir(), import.meta.path, process.execPath), { mode: 0o600 });
        const result = Bun.spawnSync(["open", `warp://launch/${name}`], { stdout: "ignore", stderr: "inherit" });
        return result.exitCode;
      }
      case "switch": {
        if (!rest[0]) { console.error(USAGE); return 2; }
        const s = await findSession(deps, rest[0]);
        if (s.status !== "running") {
          console.error(`Error: session ${s.id} isn't running.`);
          return 1;
        }
        // The Anthropic account pool only concerns profiles that actually run on such
        // an account (agent-launch requests a lease only for them) — another session has nothing
        // to switch and `/exit` would just throw away its turn in progress.
        if (!specFor(s.agent).anthropicAccount) {
          console.error(`Error: ${s.project}/${s.repo} runs ${agentLabel(s.agent)} — the Anthropic account pool only applies to native Claude sessions.`);
          return 1;
        }
        // Devd decides and also restarts the panes right away (main and main-2/main-3, see
        // accountSwitch.ts) — one call, not a decision + a separate restart, so that the
        // DB never claims a switch that did not actually happen.
        console.log(`Requesting a fresher account for ${s.project}/${s.repo}… (if this actually switches, any in-flight turn will be lost)`);
        const r = await deps.api.switchAccount(s.id);
        if (!r.accountId) {
          console.error("Error: no usable Anthropic account — check the dashboard (Login page).");
          return 1;
        }
        if (r.unchanged) {
          console.log(`Already on ${r.label} — nothing to do.`);
          return 0;
        }
        if (!r.ok) {
          const detail = r.panes.map((p) => `${p.target}=${p.outcome}`).join(", ") || "no claude pane found";
          console.error(`Error: couldn't restart any pane onto ${r.label} (${detail}).`);
          return 1;
        }
        if (r.exhausted) console.log(`Warning: ${r.label} is over the threshold too — switching anyway.`);
        console.log(`Switched ${s.project}/${s.repo} to ${r.label}.`);
        // "already-on-account" is also success (the pane was already on the target profile
        // before, so it was not touched at all) — it must not be reported as stuck on the
        // old account, even though it is not "restarted" itself.
        const stuck = r.panes.filter((p) => p.outcome !== "restarted" && p.outcome !== "already-on-account");
        if (stuck.length) {
          console.log(`Warning: some panes are still on the old account: ${stuck.map((p) => `${p.target} (${p.outcome})`).join(", ")}.`);
        }
        // The hint carries the id, not project/repo: with several sessions of the same repo it would suggest an ambiguous
        // query, on which `dev attach` would ask back (or fail in automation).
        console.log(`Done — attach with \`dev attach ${s.id}\`.`);
        return 0;
      }
      case "doctor": {
        const checks = await runDoctor(deps.cfg, deps.api);
        console.log(formatDoctor(checks));
        return checks.every((c) => c.ok) ? 0 : 1;
      }
      case "_targets": {
        for (const t of flattenTree(await deps.api.tree())) console.log(`${t.project}/${t.repo}`);
        return 0;
      }
      case "prod-writes": {
        const pending = await deps.api.prodWrites("pending");
        if (rest[0] === "--review") return await reviewProdWrites(deps, pending);
        if (pending.length === 0) { console.log("No pending prod writes."); return 0; }
        for (const w of pending) console.log(`#${w.id}  ${w.db}  ${w.session_id ?? ""}  ${w.sql.replace(/\s+/g, " ").slice(0, 80)}`);
        return 0;
      }
      case "prod-write": {
        if (!rest[0]) { console.error(USAGE); return 2; }
        const w = await deps.api.prodWrite(Number(rest[0]));
        console.log(`#${w.id}  [${w.db}]  ${w.session_id ?? ""}  (${w.status})\n${w.sql}`);
        if (w.status === "pending") {
          try { console.log(`impact preview: ${(await deps.api.prodWritePreview(w.id)).note}`); }
          catch (e) { console.log(`preview failed: ${(e as Error).message}`); }
        }
        return 0;
      }
      case "prod-approve": {
        if (!rest[0]) { console.error(USAGE); return 2; }
        console.log(`✅ ${(await deps.api.prodWriteApprove(Number(rest[0]))).note}`);
        return 0;
      }
      case "prod-reject": {
        if (!rest[0]) { console.error(USAGE); return 2; }
        await deps.api.prodWriteReject(Number(rest[0]));
        console.log("❌ rejected");
        return 0;
      }
      case "clone": {
        const arg = rest[0];
        if (!arg) { console.error(USAGE); return 2; }
        let scope: { scope: "all" } | { scope: "folder"; folder: string } | { scope: "project"; folder: string; project: string };
        if (arg === "--all") {
          scope = { scope: "all" };
        } else {
          const tree = await deps.api.tree();
          const byFolder = tree.find((p) => p.folder === arg);
          const byProject = tree.find((p) => p.project === arg);
          if (byFolder) scope = { scope: "folder", folder: arg };
          else if (byProject) scope = { scope: "project", folder: byProject.folder, project: arg };
          else { console.error(`Error: "${arg}" is not a folder or a project.`); return 1; }
        }
        const { jobId } = await deps.api.clone(scope);
        let job = await deps.api.job(jobId);
        while (job.status === "running") {
          console.log(`Cloning… ${job.done}/${job.total}`);
          await new Promise((r) => setTimeout(r, 1000));
          job = await deps.api.job(jobId);
        }
        const failed = job.results.filter((r) => !r.ok);
        console.log(`Done: ${job.done}/${job.total}${failed.length ? ` (errors: ${failed.map((f) => f.repo).join(", ")})` : ""}`);
        return failed.length ? 1 : 0;
      }
      case "backup": {
        const out = rest[0] ?? `devbox-backup-${deps.cfg.sshHost ?? "local"}.tgz`;
        const bytes = await deps.api.backup();
        await Bun.write(out, bytes);
        console.log(`Backup saved: ${out} (${(bytes.length / 1e6).toFixed(1)} MB)`);
        return 0;
      }
      case "restore": {
        if (!rest[0]) { console.error(USAGE); return 2; }
        const f = Bun.file(rest[0]);
        if (!(await f.exists())) { console.error(`Error: file ${rest[0]} does not exist.`); return 1; }
        await deps.api.restore(new Uint8Array(await f.arrayBuffer()));
        console.log("Restored. Restart devd to load the restored state: ssh <vps> systemctl restart devd");
        return 0;
      }
      case "instabox": {
        if (rest[0] === "status") {
          for (const l of instaboxStatusLines(await deps.api.instaboxStatus())) console.log(l);
          return 0;
        }
        if (rest[0] === "rebuild-base") {
          const sp = spinner();
          sp.start("Rebuilding InstaBox base…");
          try {
            const { jobId } = await deps.api.rebuildBase();
            await waitInstaboxJob({ instaboxJob: (id) => deps.api.baseJob(id) }, jobId, (st) => sp.message(`Rebuilding InstaBox base — ${BASE_STEP[st as BaseStep] ?? st}`));
          } catch (e) {
            sp.stop("Rebuild failed.");
            console.error(`Error: ${(e as Error).message}`);
            return 1;
          }
          sp.stop("InstaBox base is ready.");
          return 0;
        }
        console.error(USAGE);
        return 2;
      }
      default: {
        // The target is the only argument; anything with a dash is an unknown flag — including
        // the removed `-n`. Swallowing it silently would tell the user it still works
        // (another session is created from the menu today, see askFresh).
        if (!cmd || [cmd, ...rest].some((a) => a.startsWith("-"))) { console.error(USAGE); return 2; }
        return await pickAndOpen(deps, cmd, forcedAgent, host);
      }
    }
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    return 1;
  }
}

// A second `dev <repo>` joins, it does not create. Creating another session is a deliberate step —
// otherwise an extra container would be created by mistake with everything that comes with it (ports, worktree,
// branch). So we ask only when something is running for that target, and only on a TTY: a notification
// click and automation must keep today's behavior (join), not hang on a
// prompt against /dev/null. `undefined` = the user cancelled the question.
export async function askFresh(deps: Deps, t: Target, isTty: boolean): Promise<boolean | undefined> {
  if (!isTty) return false;
  const running = (await deps.api.sessions())
    .filter((x) => x.project === t.project && x.repo === t.repo && x.status === "running").length;
  if (running === 0) return false;
  // HOW MANY are running, not WHICH one it will be: the identity is printed by the "Session <id> running."
  // message right after opening. Naming it already here would mean the CLI has to derive by itself
  // which one devd picks — and that rule deliberately lives in a single place (existingSessionId).
  const what = await selectVal<"attach" | "fresh">(
    running > 1 ? `${running} sessions for this repo are running.` : "Session for this repo is running.", [
    { value: "attach", label: "Attach" },
    { value: "fresh", label: freshLabel(t) },
  ]);
  if (what === undefined) return undefined;
  return what === "fresh";
}

export async function pickAndOpen(deps: Deps, query: string | undefined, forced?: AgentName, host?: "instabox"): Promise<number> {
  const tree = await deps.api.tree();
  const targets = flattenTree(tree);
  let target: Target | undefined;
  const isTty = process.stdin.isTTY === true && process.stdout.isTTY === true;
  // Asking makes sense only in the step picker (no query) on a TTY and without a forcing
  // flag — computed once and propagated further, so openAndAttach/chooseSolo do not care
  // which way we got here.
  const ask = shouldAskAgent(query, forced, isTty);

  if (query) {
    const [proj, repo] = query.split("/");
    if (repo === "claudeSolo") {
      if (host === "instabox") { console.error("Error: claudeSolo runs only on the VPS."); return 1; }
      const p = tree.find((t) => t.project === proj);
      if (!p) { console.error(`Error: project "${proj}" doesn't exist.`); return 1; }
      return chooseSolo(deps, tree, p.folder, p.project, { ask, agent: forced });
    }
    const matches = resolveQuery(targets, query);
    if (matches.length === 0) {
      const sessions = await deps.api.sessions();
      const solo = sessions.find((s) => s.solo === 1 && (s.id === query || `${s.project}/${s.repo}` === query));
      if (solo) return await handleExistingSolo(deps, solo);
      console.error(`Error: "${query}" not found — try \`dev\` with no arguments.`);
      return 1;
    }
    if (matches.length === 1) {
      target = matches[0];
    } else {
      if (!requireTty()) return 1;
      target = await selectVal("Which repo?", sortByRecent(matches, recents.load())
        .map((m) => ({ value: m, label: `${m.project}/${m.repo}` })));
    }
    if (!target) return cancelled();
    // InstaBox always creates a new session — no point asking whether to join
    // the existing VPS session.
    const fresh = host === "instabox" ? true : await askFresh(deps, target, isTty);
    if (fresh === undefined) return cancelled();
    return openAndAttach(deps, target, { ask, agent: forced, fresh, host });
  }

  if (!requireTty()) return 1;
  // Step selection with going back by ONE level (Backspace/Esc = clack cancel): folder →
  // project → repo. A level with a single choice is auto-skipped and "back" continues through it
  // one step up; "back" from the first shown level returns to the manager (one level up), not
  // all the way to the start. (Previously a flat sequence → cancel anywhere ended the whole selection.)
  const folders = folderOptions(tree);
  let folder: string | undefined;
  let project: string | undefined;
  let step: 0 | 1 | 2 = 0;
  for (;;) {
    if (step === 0) {
      if (folders.length === 1) { folder = folders[0].value; step = 1; continue; }
      clearScreen();
      folder = await selectVal<string>("Folder?", folders);
      if (folder === undefined) return 0;                 // back from the first level → back to the manager
      step = 1;
    } else if (step === 1) {
      const projects = projectOptions(tree, folder!);
      if (projects.length === 1) { project = projects[0].value; step = 2; continue; }
      clearScreen();
      project = await selectVal<string>("Project?", projects);
      if (project === undefined) {                        // back → folder (or to the manager when the folder is auto)
        if (folders.length === 1) return 0;
        step = 0; continue;
      }
      step = 2;
    } else {
      clearScreen();
      const repo = await selectVal<string>("Repo?", repoOptions(tree, recents.load(), folder!, project!));
      if (repo === undefined) {                           // back → project (skip the auto level)
        if (projectOptions(tree, folder!).length === 1) {
          if (folders.length === 1) return 0;             // folder and project auto → back to the manager
          step = 0;                                       // project auto → back to folder selection
        } else {
          step = 1;
        }
        continue;
      }
      if (repo === "claudeSolo") {
        if (host === "instabox") { console.error("Error: claudeSolo runs only on the VPS."); return 1; }
        return chooseSolo(deps, tree, folder!, project!, { ask, agent: forced });
      }
      const t = targets.find((x) => x.folder === folder && x.project === project && x.repo === repo)!;
      // Same question as for `dev <repo>`: the step picker can also select a repo on
      // which a session is already running, and "join" must be a choice there, not automatic.
      // InstaBox always creates a new session — no point asking.
      const fresh = host === "instabox" ? true : await askFresh(deps, t, isTty);
      if (fresh === undefined) return cancelled();
      return openAndAttach(deps, t, { ask, agent: forced, fresh, host });
    }
  }
}

// Picking claudeSolo for a project: if any solo session is already running there,
// list them (attach) under a "new session" button; with none running — or no TTY
// (notification click, automation) — skip the menu and start a fresh one, matching
// the previous behavior and never blocking on a keypress. `tree` fills in the remembered
// agent choice for claudeSolo (soloAgent — claudeSolo is not among the tree's repos, so without
// this the picker would always offer Claude first); `opts` is propagated unchanged.
async function chooseSolo(deps: Deps, tree: TreeProject[], folder: string, project: string, opts: { ask: boolean; agent?: AgentName }): Promise<number> {
  const soloAgent = tree.find((p) => p.folder === folder && p.project === project)?.soloAgent ?? null;
  const target: Target = { folder, project, repo: "claudeSolo", cloned: false, agent: soloAgent };
  // No TTY (notification click, automation): start a fresh one without the menu —
  // and without the sessions() round trip we'd only throw away — never blocking.
  if (!(process.stdin.isTTY && process.stdout.isTTY)) return openAndAttach(deps, target, opts);
  const running = runningSolosIn(await deps.api.sessions(), folder, project);
  if (running.length === 0) return openAndAttach(deps, target, opts);
  const choice = await selectVal<string>(`claudeSolo in ${project}:`, soloMenuOptions(running, Date.now()));
  if (choice === undefined) return cancelled();
  if (choice === NEW_SOLO) return openAndAttach(deps, target, opts);
  return attachTo(deps, running.find((s) => s.id === choice)!.container);
}

// `opts.fresh` = the user picked ANOTHER session in the menu instead of joining the existing one
// (see askFresh). Not passed to claudeSolo — that has its own menu (NEW_SOLO) and devd
// has its own branch for it (openSolo), which does not know `fresh`.
export const INSTABOX_STEP: Record<string, string> = {
  preflight: "checking capacity", machine: "starting machine", ssh: "connecting SSH", tailscale: "joining tailnet",
  dirs: "preparing disk", volumes: "copying logins and settings", secrets: "passing git access", clone: "cloning repo",
  container: "starting container", desktop: "starting desktop", done: "done",
};

// Labels for `dev instabox rebuild-base` — parallel to INSTABOX_STEP, but over BaseStep
// (devd/src/instabox/base.ts). `Record<BaseStep, string>` (not string): a missing key
// should fail the typecheck, not silently print the raw step from the API.
export const BASE_STEP: Record<BaseStep, string> = {
  digest: "checking image digest", machine: "starting build machine", tools: "installing tools",
  image: "loading image", snapshot: "creating snapshot", cleanup: "cleaning up", done: "done",
};

export async function waitInstaboxJob<J extends { status: string; step: string; error?: string }>(
  api: { instaboxJob: (id: string) => Promise<J> }, jobId: string, onStep: (step: string) => void,
  sleep: (ms: number) => Promise<void> = (ms) => Bun.sleep(ms),
): Promise<J> {
  let last = "";
  for (;;) {
    const j = await api.instaboxJob(jobId);
    if (j.step !== last) { last = j.step; onStep(j.step); }
    if (j.status === "done") return j;
    if (j.status === "error") throw new Error(`${j.step}: ${j.error ?? "failed"}`);
    await sleep(1000);
  }
}

export function instaboxStatusLines(st: IbxStatus | { enabled: false }): string[] {
  if (!st.enabled) return ["InstaBox is not configured on devd."];
  if (!st.ok) return [`InstaBox API is unavailable: ${st.error ?? "unknown error"}`];
  return [
    `InstaBox ${st.machines}/${st.maxMachines} machines (${st.devboxMachines} devbox)`,
    st.base ? `Base: ${st.base.snapshotId}${st.base.stale ? " (stale — run `dev instabox rebuild-base`)" : ""}` : "Base: not built — run `dev instabox rebuild-base`",
    ...st.orphans.map((o) => `Orphaned machine: ${o.name} (${o.id}, ${o.state}) — delete it in the dashboard`),
    ...(st.buildLeftovers ?? []).map((o) => `Leftover base-build machine: ${o.name} (${o.id}, ${o.state}) — delete it in the dashboard`),
    ...st.lost.map((id) => `Session lost its machine: ${id} — end it with \`dev end ${id}\``),
  ];
}

async function openOnInstabox(deps: Deps, t: Target, agent?: AgentName): Promise<number> {
  if (!t.cloneUrl) { console.error(`Error: ${t.project}/${t.repo} has no clone URL.`); return 1; }
  const s = spinner();
  const opening = `Opening ${t.project}/${t.repo} on InstaBox`;
  s.start(`${opening}…`);
  let sessionId: string;
  try {
    const r = await deps.api.openInstabox({ folder: t.folder, project: t.project, repo: t.repo, cloneUrl: t.cloneUrl, agent });
    await waitInstaboxJob(deps.api, r.jobId, (step) => s.message(`${opening} — ${INSTABOX_STEP[step] ?? step}`));
    sessionId = r.sessionId;
  } catch (e) {
    s.stop("Open failed.");
    console.error(`Error: ${(e as Error).message}`);
    return 1;
  }
  s.stop(`Session ${sessionId} running on InstaBox.`);
  recents.touch(t);
  await deps.api.sessions(); // fills the dockerHost map (attach goes via `docker -H ssh://ibx-…`)
  return attachTo(deps, sessionId); // container == id
}

async function openAndAttach(deps: Deps, t: Target, opts: { ask: boolean; agent?: AgentName; fresh?: boolean; host?: "instabox" }): Promise<number> {
  let agent = opts.agent;
  // The remembered choice comes in the tree (repo_prefs); for claudeSolo under the key "claudeSolo".
  const remembered = t.agent ?? "claude";
  if (agent === undefined && opts.ask) {
    const picked = await selectVal<AgentName>(`Agent for ${t.project}/${t.repo}?`, agentOptions(remembered));
    if (picked === undefined) return cancelled();
    agent = picked;
  }
  if (opts.host === "instabox") return openOnInstabox(deps, t, agent);
  // VPS busy → just a hint, nothing is moved (spec §1). An older devd lacks the endpoint.
  if (t.repo !== "claudeSolo") {
    const hint = await deps.api.placement?.().catch(() => null);
    if (hint?.suggest === "instabox") log.info(`VPS is busy (${hint.reason}) — consider: dev --instabox ${t.project}/${t.repo}`);
  }
  const s = spinner();
  const opening = `Opening ${t.project}/${t.repo}`;
  s.start(`${opening}…`);
  // The initial clone of a big repo takes minutes — without progress it looks like a hang.
  // claudeSolo clones nothing, no polling there.
  let polling = t.repo !== "claudeSolo";
  const poll = async () => {
    while (polling) {
      await new Promise((r) => setTimeout(r, 1000));
      const p = polling ? await deps.api.openProgress?.({ folder: t.folder, project: t.project, repo: t.repo }) : null;
      if (polling && p) s.message(`${opening} — ${formatOpenProgress(p)}`);
    }
  };
  void poll();
  let result;
  try {
    result = t.repo === "claudeSolo"
      ? await deps.api.open({ folder: t.folder, project: t.project, solo: true, agent })
      : await deps.api.open({ folder: t.folder, project: t.project, repo: t.repo, cloneUrl: t.cloneUrl, agent, fresh: opts.fresh });
  } catch (e) {
    s.stop("Open failed.");
    console.error(`Error: ${(e as Error).message}`);
    return 1;
  } finally {
    polling = false;
  }
  s.stop(`Session ${result.session.id} running.`);
  if (result.session.host === "instabox") await deps.api.sessions(); // existing InstaBox session: fill dockerHost
  // A running session does not change its agent — say so out loud, along with the way to actually
  // get the requested agent: create ANOTHER session next to it (its own container), which
  // is a menu choice, not a flag. Guard `!opts.fresh`: whoever has just requested a new
  // session does not need advice to do what they just did.
  if (!opts.fresh && agent && result.session.agent && result.session.agent !== agent) {
    log.warn(`Already running with ${agentLabel(result.session.agent)} — attaching to it. To get ${agentLabel(agent)}, run \`dev --agent ${agent} ${t.project}/${t.repo}\` again and pick "New session".`);
  }
  if (t.repo !== "claudeSolo") recents.touch(t);
  if (result.pull?.status === "conflict") {
    log.warn(`⚠️ Pull conflict — the agent is resolving it now (files: ${result.pull.files.join(", ")})`);
  }
  return await attachTo(deps, result.session.container);
}

// An existing claudeSolo session (reached only via a direct `dev <query>` that matches
// a live solo session's id or project/repo — the picker never lists these, since they
// aren't part of the configured tree). Running sessions offer Attach or End; a
// stopped session (routine after the watchdog auto-stop) offers Restart & attach —
// devd starts the still-present container back up on the same port (restartSolo) — or
// End, deferring to the same keep/delete/gist flow `dev end` uses.
async function handleExistingSolo(deps: Deps, s: SessionInfo): Promise<number> {
  if (!requireTty()) return 1;
  if (s.status !== "running") {
    const choice = await selectVal<"restart" | "end">(`${s.project}/${s.repo} (claudeSolo) is stopped:`, [
      { value: "restart", label: "Restart and attach" },
      { value: "end", label: "End (keep/delete workspace)" },
    ]);
    if (choice === undefined) return cancelled();
    if (choice === "restart") return await restartAndAttach(deps, s);
    return await endSoloInteractive(deps, s);
  }
  const choice = await selectVal<"attach" | "end">(`${s.project}/${s.repo} (claudeSolo) is running:`, [
    { value: "attach", label: "Attach" },
    { value: "end", label: "End" },
  ]);
  if (choice === undefined) return cancelled();
  if (choice === "attach") return attachTo(deps, s.container);
  return await endSoloInteractive(deps, s);
}

// Restarts a stopped claudeSolo (devd starts the preserved container on the same
// port, restartSolo) and attaches to it right away. When the session can no longer be revived
// (container deleted, not just stopped), devd returns an error → a clear message instead of a silent
// dead end.
async function restartAndAttach(deps: Deps, s: SessionInfo): Promise<number> {
  const sp = spinner();
  sp.start(`Restarting ${s.project}/${s.repo}…`);
  try {
    await deps.api.restart(s.id);
  } catch (e) {
    sp.stop("Restart failed.");
    console.error(`Error: ${(e as Error).message}. Session can't be revived — start a new one via \`dev ${s.project}/claudeSolo\`.`);
    return 1;
  }
  sp.stop(`Session ${s.id} running.`);
  return await attachTo(deps, s.container);
}

// Shared "End claudeSolo" flow (Delete/Keep/gist, spec §14): reused by the
// interactive existing-solo picker above and directly by `dev end` on a solo session.
// A stopped session drops the gist option via `soloActionOptions` since gist execs
// into the (no-longer-running) container.
export async function endSoloInteractive(deps: Deps, s: SessionInfo): Promise<number> {
  if (!requireTty()) return 1;
  const options = soloActionOptions(s.status)
    .filter((o) => o.value !== "attach") as Option<"delete" | "keep" | "gist">[];
  const action = await selectVal<"delete" | "keep" | "gist">("End claudeSolo:", options);
  if (action === undefined) return cancelled();
  if (action === "gist") {
    const r = sh(process.cwd(), ...buildExecArgv(deps.cfg, s.container,
      'cd /workspace && gh gist create -d "claudeSolo" $(git ls-files --cached --others --exclude-standard | head -20)', false));
    const outcome = gistOutcome(r.code);
    if (outcome === "delete") {
      const out = (r.stdout + r.stderr).trim();
      if (out) console.log(out);
      await deps.api.end(s.id, "delete");
      console.log(`Deleted: ${s.project}/${s.repo}`);
      return 0;
    }
    console.error(`Failed to create gist (workspace kept): ${r.stderr.trim().slice(0, 200)}`);
    await deps.api.end(s.id, "keep");
    return 1;
  }
  await deps.api.end(s.id, action);
  console.log(action === "delete" ? `Deleted: ${s.project}/${s.repo}` : `Kept: ${s.project}/${s.repo}`);
  return 0;
}

export async function attachTo(deps: Deps, container: string, session?: string): Promise<number> {
  // Direct mirror onto a specific tmux session (from the manager, drill-down into a session) — no picker.
  if (session) return await runExitAware(deps, container, session);
  const sessions = parseProbe(sh(process.cwd(), ...probeArgv(deps.cfg, container)).stdout);
  const extras = sessions.filter((s) => s.name !== "main");
  // Only the main `main` → attach right away, nothing to choose from. Previously this also checked
  // whether anyone was attached (`#{session_attached}`), and when mirroring the picker was shown — but only
  // so that next to "Attach to main" it could offer the ALTERNATIVE "new standalone session". That
  // is gone, so the picker would have a single item, i.e. a menu without a choice. This is not a
  // mistakenly removed safeguard: it did not forbid mirroring, it only offered what to do instead.
  if (extras.length === 0) {
    return await runExitAware(deps, container, "main");
  }
  if (!requireTty()) return 1;
  // Only the choice WHERE to attach — creating another window from here is not possible (see sessionPickerOptions).
  const picked = await selectVal<string>("Attach to which session?", sessionPickerOptions(sessions));
  if (picked === undefined) return cancelled();
  return await runExitAware(deps, container, picked);
}

// Runs a tmux command in a loop (reconnect after an outage) and after F9 (code 42) shows the exit menu.
// Shared by all attach paths (interactive and notification click).
async function runExitAware(deps: Deps, container: string, tmuxSession: string, existingOnly = false, oldPaneId?: string): Promise<number> {
  const grokSupport = await detectedWarpGrokSupport();
  let connectionAttempt = 0;
  let s = (await deps.api.sessions()).find((x) => x.container === container);
  if (s) lastAttached.touch(s.id, Date.now());
  const label = s ? sessionLabel(s) : container;
  const paneId = warpPaneId();
  const recovery = terminalRecoveryStore();
  if (s && paneId) {
    recovery.write({ version: 1, paneId, sessionId: s.id, container, tmuxSession,
      devdUrl: deps.cfg.devdUrl, label, attachedAt: Date.now(), ownerPid: process.pid,
      ownerIdentity: readProcessIdentity(process.pid) });
    if (oldPaneId) recovery.forget(oldPaneId);
  }
  const forget = () => { if (paneId) recovery.forget(paneId, process.pid); };
  // Backup network path (tailnet) for retries — see dialFor in reconnect.ts. When it is not
  // configured (`sshHostAlt`), the loop behaves exactly as before.
  const alt = altCfg(deps.cfg);
  // Loop because of "Back to session" in the exit menu: F9 pressed by mistake returns
  // with another attach to the SAME session (same name, tmux has the has-session guard).
  // The session name is carried between iterations — it can be renamed in the menu and the old
  // value from the first read would lie after returning and another F9 in the menu.
  let name = s?.name ?? null;
  for (;;) {
    const namedCommand = withSessionName(tmuxCommand(tmuxSession, grokSupport, existingOnly), name);
    const code = await attachLoop({
      argv: buildExecArgv(deps.cfg, container, namedCommand),
      argvAlt: alt ? buildExecArgv(alt, container, namedCommand) : undefined,
      pathNames: alt ? [deps.cfg.sshHost!, deps.cfg.sshHostAlt!] : undefined,
      label,
      run: (argv) => {
        // After a disconnect let devd restore the exact saved process first.
        // Creating a default agent here would race server cold recovery.
        const dialCfg = alt && argv.includes(alt.sshHost!) ? alt : deps.cfg;
        return runInteractive(buildExecArgv(dialCfg, container,
          withSessionName(tmuxCommand(tmuxSession, grokSupport, existingOnly || connectionAttempt++ > 0), name)));
      },
      retryRemoteErrors: true,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      health: async () => {
        try {
          const live = (await deps.api.sessions({ timeoutMs: 10_000 })).find((x) => x.container === container);
          return live ? (live.status === "running" ? "running" : "gone") : "gone";
        } catch { return "unknown"; }
      },
    });
    if (code !== 42) {
      if (code === 0) forget();
      return code;
    }
    const r = await handleExit(deps, s, name);
    if (typeof r === "number") { forget(); return r; }
    name = r.name;
    // After an agent swap in the menu the local copy carries the new profile — otherwise the
    // "Change agent (now: …)" label would lie on the next F9.
    if (r.agent && s) s = { ...s, agent: r.agent };
  }
}

// Exit menu after F9 (code 42): Back / End / Rename / Just detach. The menu runs ON THE
// MAC, not in a popup in the container — otherwise `api.end` would delete the container from under the running popup.
// "End", after a successful API call, closes the Warp tab (SIGHUP to the parent shell → the shell exits →
// the tab closes). Without a TTY (automation) we skip the menu = plain detach (0). When we do not know
// the sessionId (edge: session not found by container), we offer only "detach".
//
// Returning `{ reattach, name }` instead of a number = the "Back to session" choice: the attach loop is held by
// the caller (runExitAware); here we only signal that it should keep going — and with which nickname
// (it could have been renamed in the menu meanwhile).
async function handleExit(deps: Deps, s: SessionInfo | undefined, name?: string | null): Promise<number | { reattach: true; name: string | null; agent?: AgentName }> {
  if (!(process.stdin.isTTY && process.stdout.isTTY)) return 0;
  if (!s) { console.error("Unknown session — just detached."); return 0; }
  clearScreen();  // show only the menu, not noise from the detached tmux / "Connection closed"
  const worktree = !!s.worktree;
  // Loop because of "Rename" and "Change agent": neither is a reason to leave the session, so
  // the menu is shown again — and since the label carries the current value, the change is
  // visible right away. The session row came from the caller (runExitAware already has it) — a second fetch
  // of the whole list on every F9 press would only slow the menu down.
  let sess = s;
  let current = name ?? null;
  let action: ExitAction | undefined;
  for (;;) {
    action = await selectVal<ExitAction>("Leave session?", exitMenuOptions(worktree, current, agentLabel(sess.agent), agentNameFor(sess.agent)));
    if (action === "account") {
      if (await pickAndSwitchAccount(deps, sess)) return { reattach: true, name: current };
      // Keep errors and partial results visible above the next menu.
      continue;
    }
    if (action === "agent") {
      // After a successful swap, reattach right away — the user returns to the tab where the
      // new agent is already starting (and the caller updates the profile for the next F9 from the return value).
      // After a failure/cancel the DB has not changed, the menu is just shown again.
      const next = await pickAndSwitchAgent(deps, sess);
      clearScreen();
      if (next) return { reattach: true, name: current, agent: next };
      continue;
    }
    if (action !== "rename") break;
    const next = await promptName("Session name (empty = clear)", current);
    if (next === undefined) { clearScreen(); continue; }   // Ctrl-C in the prompt = back to menu
    try {
      await deps.api.setName(sess.id, next);
      current = sanitizeSessionName(next);
    } catch (e) {
      console.error(`Rename failed: ${(e as Error).message}`);
    }
    clearScreen();
  }
  if (action === "back") { clearScreen(); return { reattach: true, name: current }; }
  if (action === undefined || action === "detach") return 0;
  try {
    await deps.api.end(sess.id); console.log(`Ended — ${endEffect(worktree)}.`);
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    return 1;
  }
  // Close the Warp tab: SIGHUP to the parent shell. Only after a successful API call.
  closeParentTab();
  return 0;
}

// Picking a new profile + live agent swap via devd (POST /api/sessions/:id/agent).
// Returns the chosen profile when at least one pane has verifiably switched (the caller then
// typically reattaches and updates its labels), otherwise null. Shared by the F9 menu
// (handleExit) and the manager (containerDetail).
// Whether the conversation survives is told by conversationCarries — the SAME predicate by which
// devd actually carries the id over (agentSwitch.ts): switching to a different CLI loses it, so
// it is confirmed; a swap within claude is not.
export async function pickAndSwitchAgent(deps: Deps, s: Pick<SessionInfo, "id" | "agent" | "project" | "repo">): Promise<AgentName | null> {
  const current = agentNameFor(s.agent);
  const target = await selectVal<AgentName>(`Agent for ${s.project}/${s.repo}?`, agentOptions(current, "current"));
  if (target === undefined || target === current) return null;
  if (!conversationCarries(specFor(current).runtime, specFor(target).runtime)) {
    const ok = await confirm({ message: `Switch to ${agentLabel(target)}? The conversation will NOT carry over (different CLI) — only the workspace stays.` });
    if (isCancel(ok) || !ok) return null;
  }
  console.log(`Switching ${s.project}/${s.repo} to ${agentLabel(target)}… (any in-flight turn will be lost)`);
  try {
    const r = await deps.api.switchAgent(s.id, target);
    const summary = agentSwitchSummary(r, agentLabel(target));
    if (r.ok) log.success(summary); else log.error(summary);
    return r.ok ? target : null;
  } catch (e) {
    log.error(`Agent switch failed: ${(e as Error).message}`);
    return null;
  }
}

export interface AccountSwitchUi {
  select: (message: string, options: Option<string>[]) => Promise<string | undefined>;
  confirm: (message: string) => Promise<boolean>;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
  success: (message: string) => void;
}
const accountSwitchUi: AccountSwitchUi = {
  select: selectVal,
  confirm: async (message) => {
    const ok = await confirm({ message, initialValue: false });
    return !isCancel(ok) && ok;
  },
  info: log.info, warn: log.warn, error: log.error, success: log.success,
};

// Return to the original tmux target only after a clean switch. Cancellation,
// no-op and failures stay in F9, where the user can read the result and reattach.
export async function pickAndSwitchAccount(
  deps: Deps,
  s: Pick<SessionInfo, "id" | "agent" | "project" | "repo">,
  ui: AccountSwitchUi = accountSwitchUi,
): Promise<boolean> {
  if (s.agent !== "codex" && !specFor(s.agent).anthropicAccount) {
    ui.error("Account switching is available for native Claude Code and Codex sessions only.");
    return false;
  }
  try {
    if (s.agent !== "codex") {
      if (!await ui.confirm("Automatically choose a fresher Anthropic account for Claude Code? Each Claude pane restarts and resumes its exact current conversation. Unfinished local turns may be interrupted; if the conversation cannot be resumed, switching stops without starting a new one.")) return false;
      ui.info("Switching Claude Code account automatically…");
      const r = await deps.api.switchAccount(s.id);
      if (!r.accountId) {
        ui.error("No usable Anthropic account — check the dashboard (Login page).");
        return false;
      }
      if (!r.ok) {
        const detail = r.panes.map(p => `${p.target} (${p.outcome})`).join(", ") || "no Claude pane found";
        ui.error(`Account switch failed for ${r.label}: ${detail}.`);
        return false;
      }
      if (r.unchanged) { ui.info(`Already on ${r.label} — nothing to do.`); return false; }
      if (r.exhausted) ui.warn(`${r.label} is over the usage threshold too.`);
      const stuck = r.panes.filter(p => p.outcome !== "restarted" && p.outcome !== "already-on-account");
      if (stuck.length) {
        ui.warn(`Only some Claude panes switched to ${r.label}. Check these panes: ${stuck.map(p => `${p.target} (${p.outcome})`).join(", ")}.`);
        return false;
      }
      ui.success(`Switched Claude Code to ${r.label}; the same conversations are resumed.`);
      return true;
    }

    const view = await deps.api.codexAccount(s.id);
    const labelFor = (id: string | null) => id === null ? "unknown account" : view.accounts.find(a => a.id === id)?.label ?? id;
    const pendingTargets = [...new Set(view.panes.flatMap(p => p.pending ? [p.pending.accountId] : []))];
    const finishing = pendingTargets.length > 0;
    if (pendingTargets.length > 1) {
      ui.error("This session has unfinished switches to different Codex accounts. Resolve the pending conversations before selecting another account.");
      return false;
    }
    if (finishing) ui.info(`Unfinished Codex account switch to ${labelFor(pendingTargets[0]!)}. Finish switching to resume the same conversations.`);
    if (view.currentAccountId !== null) ui.info(`Current Codex account: ${labelFor(view.currentAccountId)}.`);
    else if (view.panes.length) ui.info(`Current Codex accounts: ${view.panes.map(p => `${p.target}: ${p.accountId === null && p.pending ? "stopped; continuation pending" : labelFor(p.accountId)}`).join("; ")}.`);
    else { ui.info("No running Codex pane found — start Codex in Terminal first."); return false; }

    for (const account of view.accounts.filter(a => a.disabled || !a.available)) {
      ui.info(`${account.label}: ${account.unavailableReason ?? (account.disabled ? "account disabled" : "unavailable in this session")}`);
    }
    const available = view.accounts.filter(a => !a.disabled && a.available && (!finishing || a.id === pendingTargets[0]));
    if (!available.length) { ui.info("No selectable Codex account is available in this session."); return false; }
    const picked = await ui.select(`${finishing ? "Finish switching Codex account" : "Codex account"} for ${s.project}/${s.repo}?`, [
      ...available.map(a => ({
        value: a.id,
        label: finishing ? `${a.label} (finish switching)` : a.label,
        hint: [a.id === view.currentAccountId ? "current" : null, a.isDefault ? "default" : null].filter(Boolean).join(" · ") || undefined,
      })),
      { value: "__back__", label: "← Back" },
    ]);
    if (picked === undefined || picked === "__back__") return false;
    const target = available.find(a => a.id === picked);
    if (!target) { ui.error("That Codex account is unavailable. Reopen Change account to refresh the list."); return false; }
    if (!finishing && picked === view.currentAccountId) { ui.info(`Already on ${target.label} — nothing to do.`); return false; }
    if (!await ui.confirm(`${finishing ? "Finish switching" : "Switch"} Codex to ${target.label}? Each Codex pane resumes its exact current conversation on this account. Unfinished turns may be interrupted; if the conversation cannot be resumed, switching stops without starting a new one.`)) return false;
    ui.info(`Switching Codex to ${target.label}…`);

    const r = await deps.api.switchCodexAccount(s.id, picked);
    const failed = r.panes.filter(p => p.outcome !== "restarted" && p.outcome !== "already-on-account");
    const detail = failed.map(p => `${p.target} (${p.outcome})`).join(", ");
    if (!r.ok) {
      ui.error(`Codex account switch failed: ${r.error ?? "the account change could not be confirmed"}${detail ? ` — ${detail}` : ""}.`);
      return false;
    }
    if (failed.length) {
      ui.warn(`Codex account switch is incomplete. Check these panes: ${detail}.`);
      return false;
    }
    if (r.unchanged) { ui.info(`Already on ${r.label} — nothing to do.`); return false; }
    ui.success(`Switched Codex to ${r.label}; the same conversations are resumed.`);
    return true;
  } catch (e) {
    ui.error(`Account switch failed: ${(e as Error).message}`);
    return false;
  }
}

// SIGHUP to the parent shell so the Warp tab closes after a successful end/stop. Non-critical:
// end/stop has already happened, so a kill failure (ESRCH — the process is already gone, EPERM — someone else's
// process) must not fall through as "Error" + exit 1 — the tab simply stays open.
export function closeParentTab(): void {
  if (!process.ppid) return;
  try { process.kill(process.ppid, "SIGHUP"); }
  catch { /* non-critical — end/stop already happened, the tab just does not close by itself */ }
}

export async function selectVal<T>(message: string, options: Option<T>[]): Promise<T | undefined> {
  const v = await select<T>({ message, options });
  return isCancel(v) ? undefined : v;
}
export function cancelled(): number { outro("Cancelled."); return 0; }

// clack's `select` renders a prompt and awaits a keypress; against a non-interactive
// stdin/stdout (e.g. piped or /dev/null) it never resolves, hanging the process. Every
// call site that's about to prompt must check this first and fail closed instead.
export function requireTty(): boolean {
  if (process.stdin.isTTY && process.stdout.isTTY) return true;
  console.error("Error: interactive selection requires a terminal.");
  return false;
}

if (import.meta.main) {
  const cfg = loadCliConfig();
  process.exit(await run(process.argv.slice(2), { cfg, api: new ApiClient(cfg.devdUrl) }));
}
