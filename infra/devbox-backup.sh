#!/usr/bin/env bash
# Devbox backup → borg repo on the backup server (from where its own daily borg can
# ship it further, e.g. to a Storage Box). Two levels on purpose:
#
#   devbox --[borg, encrypted with a passphrase]--> backup-host:/var/backups/devbox-borg
#          --[daily borg of the backup server, /var/backups is in its paths]--> Storage Box
#
# Why via the backup server and not directly to the Storage Box: the devbox has no key to the Storage Box and
# adding one is only possible with the account password. This way we need no new access — just
# the devbox→backup server key.
#
# Why borg ALREADY ON THE DEVBOX and not a plain tar: the backup contains /etc/devd/secrets.json
# (1P token, Pushover, Gitea, Beszel…). So it is encrypted before the data leaves
# the devbox — the backup server never sees plaintext.
set -uo pipefail

# Target and key are per-install → /etc/devd/devd.env (see infra/devd.env.example).
REPO="${DEVBOX_BORG_REPO:-}"
PASS_FILE="${DEVBOX_BORG_PASSFILE:-/etc/devd/borg-passphrase}"
KEY="${DEVBOX_BORG_KEY:-/root/.ssh/id_ed25519_backup}"
STATUS_FILE="${DEVBOX_BACKUP_STATUS:-/var/lib/devd/backup-status.json}"
LOG_FILE="${DEVBOX_BACKUP_LOG:-/var/log/devbox-backup.log}"
RETENTION_DAILY=7
RETENTION_WEEKLY=4
RETENTION_MONTHLY=6

mkdir -p "$(dirname "$LOG_FILE")" "$(dirname "$STATUS_FILE")"
exec > >(tee -a "$LOG_FILE") 2>&1
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

START=$(date +%s)

# State for the dashboard (Hardware tab). Written on failure too — "don't know" is worse
# information than "failed at 02:30".
#
# `message` is shown 1:1 in the dashboard, and the dashboard is in ENGLISH — so the messages
# passed here (and all `fail` calls) are English, as is the `log` output to the file.
write_status() {
  local state="$1" message="$2" archive="${3:-}"
  local end; end=$(date +%s)
  cat > "${STATUS_FILE}.tmp" <<JSON
{
  "state": "${state}",
  "message": $(printf '%s' "$message" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'),
  "archive": "${archive}",
  "startedAt": $((START * 1000)),
  "finishedAt": $((end * 1000)),
  "durationSec": $((end - START))
}
JSON
  mv "${STATUS_FILE}.tmp" "$STATUS_FILE"
  chmod 644 "$STATUS_FILE"
}

fail() { log "ERROR: $*"; write_status "failed" "$*"; exit 1; }

[ -n "$REPO" ] || fail "DEVBOX_BORG_REPO is not set (/etc/devd/devd.env)"
[ -r "$PASS_FILE" ] || fail "passphrase file $PASS_FILE is missing"
[ -r "$KEY" ] || fail "SSH key $KEY is missing"

BORG_PASSPHRASE="$(cat "$PASS_FILE")"
export BORG_PASSPHRASE
# The SSH port belongs in DEVBOX_BORG_REPO (ssh://user@host:port/path).
export BORG_RSH="ssh -i ${KEY} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15"
# borg binary on the remote side, e.g. "borg-1.4" on a Hetzner Storage Box.
[ -z "${DEVBOX_BORG_REMOTE_PATH:-}" ] || export BORG_REMOTE_PATH="$DEVBOX_BORG_REMOTE_PATH"
# Non-interactive: never prompt, fail instead (runs from a timer, nobody is there to answer).
export BORG_RELOCATED_REPO_ACCESS_IS_OK=no
export BORG_UNKNOWN_UNENCRYPTED_REPO_ACCESS_IS_OK=no

ARCHIVE="devbox-$(date +%Y-%m-%d_%H-%M-%S)"

# devd writes to devd.sqlite all the time, so a plain copy of the live file can
# capture a half-written transaction — a corrupted database would be restored. `.backup`
# uses SQLite's online backup API and gives a consistent snapshot even while running.
# The snapshot is what to restore from; the live file is in the archive too, but only
# as a bonus (deduplication makes it nearly free anyway).
DB_LIVE=/var/lib/devd/devd.sqlite
SNAP_DIR=/var/lib/devd/backup-snapshot
if [ -f "$DB_LIVE" ]; then
  if command -v sqlite3 >/dev/null 2>&1; then
    mkdir -p "$SNAP_DIR"
    if sqlite3 "$DB_LIVE" ".backup '${SNAP_DIR}/devd.sqlite'" 2>/dev/null \
      && [ "$(sqlite3 "${SNAP_DIR}/devd.sqlite" 'PRAGMA integrity_check;' 2>/dev/null)" = "ok" ]; then
      log "devd.sqlite snapshot is consistent ($(du -h "${SNAP_DIR}/devd.sqlite" | cut -f1))"
    else
      # Do not abort the whole backup — the rest (volumes, secrets, workspace) is worth it anyway.
      log "WARNING: devd.sqlite snapshot failed, the archive will only have the live file"
      rm -f "${SNAP_DIR}/devd.sqlite"
    fi
  else
    log "WARNING: sqlite3 is missing, devd.sqlite is backed up without a consistent snapshot"
  fi
fi

# What gets backed up. Docker volumes are taken directly from the host path — going
# through `docker run tar` would mean an extra intermediate step on disk.
PATHS=(
  /var/lib/docker/volumes/claude-home/_data      # logins, plugins, MCP, conversation history
  /var/lib/docker/volumes/codex-home/_data       # same for Codex
  /var/lib/docker/volumes/grok-home/_data        # same for Grok
  /var/lib/docker/volumes/antigravity-home/_data # same for Antigravity
  /var/lib/devd                                  # devd.sqlite = the only source of statistics
  /etc/devd                                      # secrets.json + config
  /root/.ssh
  /srv/dev                                       # workspaces — for UNcommitted work
)
# Per-account homes of the account pool (one volume per extra Claude/Codex account).
for p in /var/lib/docker/volumes/codex-acct-*/_data /var/lib/docker/volumes/claude-acct-*/_data; do
  [ ! -d "$p" ] || PATHS+=("$p")
done
# Storage guard state and host configuration (infra/storage-guard), when installed.
PATHS+=(
  /etc/devbox-storage
  /var/lib/devbox-storage
  /usr/local/lib/devbox-storage
  /etc/logrotate.d/devbox-storage
  /etc/systemd/journald.conf.d/70-devbox-storage.conf
  /etc/sysctl.d/70-devbox-core.conf
  /etc/security/limits.d/70-devbox-core.conf
  /etc/systemd/system.conf.d/70-devbox-core.conf
)
for p in /etc/systemd/system/devbox-storage*; do [ ! -e "$p" ] || PATHS+=("$p"); done
EXISTING=()
for p in "${PATHS[@]}"; do
  [ -e "$p" ] && EXISTING+=("$p") || log "skipping missing path $p"
done
[ ${#EXISTING[@]} -gt 0 ] || fail "none of the backed-up paths exist"

log "Step 1/3: borg create ${ARCHIVE}"
borg create \
  --stats --show-rc \
  --compression zstd,3 \
  --one-file-system \
  --exclude '*/node_modules/*' \
  --exclude '*/.cache/*' \
  --exclude '*/.next/*' \
  --exclude '*/dist/*' \
  --exclude '*/build/*' \
  --exclude '*/target/*' \
  --exclude '*/.venv/*' \
  --exclude '*/__pycache__/*' \
  --exclude '*/.pytest_cache/*' \
  --exclude '*.sock' \
  "${REPO}::${ARCHIVE}" \
  "${EXISTING[@]}"
rc=$?
# borg returns 1 as a WARNING (a file changed while being read) — the archive was still created.
if [ $rc -ge 2 ]; then fail "borg create exited with code $rc"; fi
[ $rc -eq 1 ] && log "borg create reported a warning (rc=1), the archive was created"

log "Step 2/3: prune ${RETENTION_DAILY}d / ${RETENTION_WEEKLY}w / ${RETENTION_MONTHLY}m"
borg prune --list --show-rc --glob-archives 'devbox-*' \
  --keep-daily "$RETENTION_DAILY" --keep-weekly "$RETENTION_WEEKLY" --keep-monthly "$RETENTION_MONTHLY" \
  "$REPO"
[ $? -ge 2 ] && log "WARNING: prune failed, but the archive exists"

log "Step 3/3: compact"
borg compact "$REPO"
[ $? -ge 2 ] && log "WARNING: compact failed"

SIZE="$(borg info --json "$REPO" 2>/dev/null \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print(round(d["cache"]["stats"]["unique_csize"]/1e9, 2))' 2>/dev/null || echo "?")"

log "Done in $(( $(date +%s) - START )) s, repo ${SIZE} GB"
write_status "ok" "archive ${ARCHIVE}, repo ${SIZE} GB" "$ARCHIVE"
