# Devbox storage guard

Independent systemd services, Python 3 standard library and Borg 1.4. No devd,
Docker daemon or active session restart is needed to install this protection.

## Policy

* Disk check every 5 minutes; ownership/accounting every hour and after container
  lifecycle changes. Alert at 70%, block new managed copies/builds at 85% or less
  than 100 GiB available. Alert on 50 GiB growth over the observed 24-hour window.
* Per-session workspace + writable layer + nested Docker storage: warn at 40 GiB,
  block new Git clones/worktrees and Docker builds/pulls at 80 GiB. Shared account
  volumes are not charged repeatedly to every session. These are admission guards,
  not kernel filesystem quotas: arbitrary writes or explicit /usr/bin commands
  cannot be stopped without changing the underlying storage layout.
  `session_limits` in the config overrides warn/block per session (for example a
  session that legitimately holds a very large repository). Existing over-warning baselines
  are quiet; notify on threshold crossings or growth of at least 10 GiB per scan.
* `/usr/local/bin/git` and `docker` in each session delegate to the original
  `/usr/bin` tools. Existing unrelated wrappers are never overwritten. Root-owned
  state is published through the existing `/run/devd` mount.
* `devbox-scratch create PATH [REF]` creates a linked worktree and records its
  purpose (`DEVBOX_SCRATCH_PURPOSE`), owner and time. `release PATH` marks it finished.
  The sweep runs daily and, under disk pressure (warn threshold or reserve), is also
  started by the 5-minute sample at most once an hour. It only removes explicitly
  released worktrees after their owning container no longer exists, or after a
  release grace period (`release_grace_hours`, default 1) for a live owner. A session
  worktree (`.worktrees/`, `.claude/worktrees/`) its agent never released is released by
  the sweep once it is in Git (see below), unreferenced and without Git activity for
  `idle_release_hours` (default 12; audit `idle-worktree-released`), unless its Git dir
  holds a paused rebase/merge/bisect, worktree-only refs or a lock with a stated reason.
  Such an auto-released worktree is only ever removed in-Git, never archived: if it changed,
  the release is dropped and the next sweep judges it again. It requires
  fresh inventory and no references/mounts (including container namespace aliases,
  checked by device/inode). A released worktree that is already in Git (clean, no
  untracked files, HEAD on a remote ref, ignored files only regenerable output such as
  `__pycache__`/`node_modules`) is removed right away without an archive, re-checked just
  before removal. Its HEAD and the commits only its HEAD reflog still references (rebased,
  amended, left on a detached HEAD) are pinned first as `refs/devbox/released/<sha>` in the
  shared repo; a pin is dropped once a branch or tag holds the commit, or after
  `released_pin_days` (default 90). Git for this check runs as the worktree's owner; root-owned worktrees and
  failed removals take the archive path. Every other one needs an encrypted offsite archive including the Git
  common directories, an unchanged signature per worktree and a full Borg integrity
  read; a worktree that changed meanwhile is kept. Archives are made in batches of
  `sweep_batch_size` (default 8), each removed and recorded before the next; no new batch
  starts after `sweep_budget_seconds` (default 9000, below the 4 h unit timeout) and the
  backlog is notified and continues in the next run. A released worktree whose Git
  registration was pruned is archived and then deleted directly, together with a
  leftover registration that still names it. Unknown copies need review.
* The same sweep removes session directories (`/srv/dev/_sessions/<id>`) that no session
  owns any more: unknown to devd (`sessions_url`), no container, unchanged for the grace
  period and unreferenced (retained Codex workspaces, worktrees kept by autoEnd, failed
  starts). They go into the sweep's archive first, then the directory and its (often locked)
  Git registration are removed. An unreachable devd removes nothing. Claude chats are not
  there: devd moves them to `/srv/dev/_chat-archive/<id>-<time>` when a session ends.
* At most `checkout_slots` (default 2) `git worktree add` / `devbox-scratch create` run at
  once per repository (a lock in the shared Git common dir); a further one waits up to 90 s,
  then exits 75 with a retry message instead of outliving an agent's tool timeout.
* A repository opts into sparse worktrees with a `devbox-sparse-checkout` file in its shared
  Git dir (non-cone patterns, one per line, e.g. `/*` and `!/props/`). New worktrees from
  `git worktree add` / `devbox-scratch create` then check out only those files and print how
  to widen them; `DEVBOX_FULL_CHECKOUT=1` skips it. The session's main worktree (made by
  devd) stays full. The fast sweep accepts files the sparse checkout left out.
* `git worktree prune` is refused inside sessions: the bare clone is shared, and the
  container cannot see sibling sessions' paths, so prune unregistered their worktrees.
* Explicit session End/removal is intercepted at host Docker CLI level: stop the
  target and its nested daemon, preserve the writable rootfs, workspace, Git common
  directory, nested databases and session transcript directory offsite, then allow
  removal. The read-back covers what End deletes (owned data, the workspace's worktree
  registration, the rootfs once through `tar`), and a metadata listing of the archive must show
  every owned file with its type and size (borg leaves out a file it cannot read and only warns).
  The shared Git store is archived but not re-downloaded; content that is only staged (index
  differs from the working tree) lives as blobs there, so its restore relies on that unverified
  part. Sources are signed by inode/size/mtime/ctime, not content hashes (owner decision
  2026-11-23): borg reads each file more than a timestamp tick after its first stat, so any
  later write, by any process, moves ctime. The session and its sidecar must stay stopped with
  the same StartedAt, and the proof records that StartedAt for the Docker wrapper's check.
  When this takes more than 40 seconds End returns an actionable retry;
  the systemd archive job continues and no removal occurs until it is verified.
  A simple session Stop does not trigger archival/removal.
* Archived Codex `.jsonl` conversations older than 30 days are offloaded only after
  a byte-identical restore check and a second source/reference check. Active
  `/sessions` history is never automatically removed. Batches are bounded to
  512 MiB / 2,048 files; a single oversized history can be offloaded separately.
* The shared npm download cache is kept around 5 GiB by evicting blobs unused for
  at least seven days, only outside package install/exec activity. `_npx` executable
  trees and installed dependencies are never removed by this policy. A busy cache
  can remain above the target until safe candidates exist.
* The existing recovery set is backed up offsite and retained locally at least
  30 days from successful verification. Removal requires the entire set to remain
  unchanged and another offsite integrity read. Retain storage-guard-* archives
  for 180 days, plus 12 monthly recovery points, in a dedicated encrypted offsite repository (devbox-storage-guard).
* Log rotation, 1 GiB journal limit and core=0 for existing session processes and
  new containers prevent unbounded diagnostic output. A kernel core-pipe sink
  also prevents dumps from old Docker exec processes that inherit unlimited
  limits. This disables crash dump files globally on this devbox; existing core
  files are not deleted by this policy.

## Operations

```
devbox-storage status
systemctl start devbox-storage-inventory.service
systemctl start devbox-storage-maintenance.service
journalctl -u devbox-storage-inventory -u devbox-storage-maintenance
cat /var/lib/devbox-storage/actions.jsonl
cat /var/lib/devbox-storage/review.json
```

Per-session overrides live in `session_limits` in `/etc/devbox-storage/config.json`.
Alerts use the existing devd notification endpoint, with six-hour cooldown per
category/session. Operational failures retry automatically after ten minutes;
notify only after three failures in two hours (the maintenance sweep, which runs for
hours, on its first failure), never instructing the user to run
commands. Deliberate service stops do not notify. `notify_enabled=false` mutes
deployment tests. Notification failure never authorizes cleanup.

## Restore

Load the Borg passphrase through `BORG_PASSCOMMAND='cat /etc/devd/borg-passphrase'`
and use the SSH key and Borg remote path from config. Archive names and source
paths are in `/var/lib/devbox-storage/actions.jsonl` and `/prepared/*.json`.
Extract into a NEW private directory. End snapshots consist of two archives:
`end-data` contains host workspace/common Git objects/sidecar data; `end-rootfs`
contains `rootfs.tar` (a Docker export, excluding mounted volumes). Restore both.
The previous cleanup's Borg archive/bundle/restore script remain together in
the recovery offsite archive. Never restore over a live session automatically.

## Rollback

Disable the four devbox-storage timers and event service. Remove only symlinks
pointing to `/usr/local/lib/devbox-storage/client.py` from session containers and
the host docker wrapper if its hash matches this package. The originals in
`/usr/bin` remain untouched. Existing archives and audit records remain intact.
Core hard limits on already-running processes intentionally last until those
processes exit; reverting files does not raise their limits.
