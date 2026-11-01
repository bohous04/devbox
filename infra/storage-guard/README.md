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
  The daily sweep only removes explicitly released worktrees after their owning
  container no longer exists, or after a 24-hour release grace period for a live
  owner. It requires fresh inventory, no references/mounts (including container
  namespace aliases, checked by device/inode),
  an encrypted offsite archive including the Git common directory, stable source
  signatures and a full Borg integrity read. Unknown/broken copies need review.
* Explicit session End/removal is intercepted at host Docker CLI level: stop the
  target and its nested daemon, preserve the writable rootfs, workspace, Git common
  directory, nested databases and session transcript directory offsite, then allow
  removal. When this takes more than 40 seconds End returns an actionable retry;
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
notify only after three failures in two hours, never instructing the user to run
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
