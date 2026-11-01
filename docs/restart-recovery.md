# Restart recovery

Prepared source lives in `VPSbetter-recovery-20260911`, on the captured production
baseline. This change has **not been activated** on the devbox. No existing
session, container, Docker daemon, or machine was restarted during preparation.

## Behavior

- Docker already uses `unless-stopped` for devboxes and their DinD sidecars.
  devd now reconciles previously running rows after startup, retries transient
  failures, preserves intentionally stopped rows, and checks recovery readiness.
- Each devbox saves tmux sessions, windows, split layouts, active selections,
  labels, working directories, exact agent conversation and account identities.
  A monitor writes every five seconds; accepted agent hooks checkpoint immediately.
  Graceful devd shutdown checkpoints running sessions before Docker stops.
- Container replacement checkpoints first and keeps the workspace unchanged.
  Starting a retained stopped DinD now explicitly starts that daemon rather than
  waiting for an existing-but-stopped sidecar to become ready by itself.
- Inner Docker restoration uses full IDs that were running in the same recorded
  DinD daemon. It never runs compose, pulls images, or adopts a replacement daemon.
  Missing containers remain a visible pending condition rather than being rebuilt.
- Only a recorded active, unblocked turn gets a continuation prompt. Completed
  turns, questions, approval waits, failures/rate limits, and unknown lifecycle
  state reopen without a new prompt. Agent wrappers omit their new-session
  permission bypass flags during recovery.
- Codex Remote must prove exact route ownership, an idle/unloaded interrupted
  turn, and a shared exclusive claim for that turn before sending continue. A live
  or completed central turn receives no extra prompt. Legacy standalone Codex
  stays standalone; its exact identity can be bootstrapped from its process's
  open rollout files and root-thread SQLite metadata without reading chat text.
- Ordinary shells reopen at their recorded working directory. Arbitrary shell
  commands/background processes are not replayed. Unknown agent identity leaves a
  shell with a visible explanation. Secrets and user prompts are never journaled.

The journal is `/run/devd/recovery/` in a session, backed by
`/var/lib/devd/sessions/<session-id>/recovery/` on the host. `latest.json` is the
latest snapshot; per-pane files preserve the last accepted hook. Immutable
`plan-*.json` files and claims make retries reviewable. `restore-incomplete` and
`pending-docker.json` protect unfinished recovery from being overwritten by a
fallback shell. Do not remove these files as a routine cleanup.

## Activation after approval

1. Recompare the production files with the captured baseline before applying the
   prepared diff; preserve independent changes. Record the exact running devbox
   IDs, image IDs, `/workspace` and `/run/devd` bind sources, entrypoint paths, and
   matching DinD volume IDs. Back up the files that will be replaced.
2. Build the updated image for future containers. A Docker build alone does not
   update scripts inside existing containers. For every running session, hot-copy
   the following files without stopping its agents:

   | Source | Container destination |
   | --- | --- |
   | `image/devbox-recovery` | `/usr/local/bin/devbox-recovery` (0755) |
   | `image/recovery/rpc.py` | `/usr/local/lib/devbox-recovery/rpc.py` (0644) |
   | `image/entrypoint.sh` | `/usr/local/bin/devbox-entrypoint` (0755) |
   | `image/agent-launch.sh` | `/usr/local/bin/agent-launch` (0755) |
   | `image/co`, `image/cc`, `image/gr` | matching `/usr/local/bin/` wrappers (0755) |
   | `image/codex-remote` | `/usr/local/bin/codex-remote` (0755) |
   | `image/vendor/warp-hooks/warp-title.py` | `/opt/warp-hooks/warp-title.py` (0755) |

   Inspect each container's actual `.Config.Entrypoint`: an older image may use
   `/entrypoint.sh`. When that is its recorded entrypoint, update that path too.
   Preserve container user and bind ownership; run checkpoint/monitor as uid 1000,
   not root. Do not change any account credentials or restart the host Codex server.
3. Before the first restart, run `devbox-recovery inspect` in each existing
   container. Every actual agent pane must have `ready:true`; shell panes have
   `kind:"shell"`. If an agent is unready, preserve its current process and resolve
   the exact metadata. Do not substitute a latest conversation or default account.
4. Run `devbox-recovery snapshot`, then start
   `docker exec -d -u 1000:1000 <exact-id> /usr/local/bin/devbox-recovery monitor`.
   Its generation-specific lock permits one monitor only. Recheck `inspect`, the
   durable journal owner/mode, and `check-ready` in every session. Confirm one
   journal row per actual tmux pane and saved running inner Docker IDs against the
   same DinD daemon. Snapshot/inspect do not send model prompts.
5. Deploy the matching devd source changes and the service shutdown timeout;
   reload systemd and restart **devd only**. Running devbox agent processes remain
   intact. Verify HTTP health, no failed startup recovery entries, unchanged
   container/process identities, and exact tmux names still available to the Mac.
6. Verify the first real container cold restart only in an explicitly agreed
   disposable fixture or during the user's next planned maintenance. A full
   devbox reboot is not needed for initial activation. Do not claim live cold
   recovery from an image build or daemon health alone.

Stopped existing containers also need the recovery-capable scripts before their
next intentional open (Docker cp supports stopped containers). They must remain
stopped during activation. Their historical lost tmux state cannot be recreated
if it was never checkpointed.

## Verification performed locally

`python3 -m unittest devd/test/devboxRecovery_test.py -v` runs an isolated real
tmux server with fake agent executables. It saves two sessions, multiple windows
and a split, kills that private tmux server, restores the topology and exact IDs,
and verifies one continue only for the interrupted pane. Other regressions cover
the final permission hook before a crash, a partial new-conversation checkpoint,
journal preservation, headless helper exclusion, account validation, and DinD
identity mismatch. No real model or Docker daemon is used.

`bun test devd/test/recovery.test.ts devd/test/remoteRestore.test.ts` verifies
bounded startup retries and existing exact workspace restoration, including real
offline Git branch/index/dirty-file preservation.

After activation, `devbox-recovery check-ready` returns nonzero for incomplete
tmux or Docker recovery. Check the container log and retained journal before
retrying. Auto-continue claims prioritize avoiding duplicate work: if a process
crashes after claiming a turn but before the model accepts its prompt, the
conversation may require an explicit manual continue.
