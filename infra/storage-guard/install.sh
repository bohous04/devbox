#!/usr/bin/env bash
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo 'Run on the devbox host as root'; exit 1; }
src=$(cd -- "$(dirname -- "$0")" && pwd)
dst=/usr/local/lib/devbox-storage
install -d -m 755 "$dst" /etc/devbox-storage
install -d -m 700 /var/lib/devbox-storage
install -m 755 "$src/guard.py" "$src/client.py" "$src/host-docker.py" "$src/events.py" "$dst/"
[ -f /etc/devbox-storage/config.json ] || install -m 644 "$src/config.example.json" /etc/devbox-storage/config.json
ln -sfn "$dst/guard.py" /usr/local/bin/devbox-storage
# Must not replace a previously installed third-party wrapper.
if [ -e /usr/local/bin/docker ] || [ -L /usr/local/bin/docker ]; then
  [ "$(readlink /usr/local/bin/docker)" = "$dst/host-docker.py" ] || { echo 'Existing host docker wrapper; refusing overwrite'; exit 1; }
else
  ln -s "$dst/host-docker.py" /usr/local/bin/docker
fi

for task in sample inventory maintenance retention; do
  cmd=$task
  burst=6
  if [ "$task" = sample ] || [ "$task" = inventory ]; then burst=60; fi
  [ "$task" != maintenance ] || cmd=sweep
  cat > "/etc/systemd/system/devbox-storage-$task.service" <<EOF
[Unit]
Description=Devbox storage guard: $task
After=docker.service network-online.target
OnFailure=devbox-storage-failure@%n.service
StartLimitIntervalSec=2h
StartLimitBurst=$burst
[Service]
Type=oneshot
ExecStart=/usr/local/bin/devbox-storage $cmd
Nice=15
IOSchedulingClass=best-effort
IOSchedulingPriority=7
TimeoutStartSec=4h
Restart=on-failure
RestartSec=10min
MemoryMax=8G
EOF
done
# Explicitly disposable images and old unused build cache are reproducible.
cat >> /etc/systemd/system/devbox-storage-maintenance.service <<'EOF'
ExecStart=/usr/local/bin/devbox-storage docker-maintenance
ExecStart=/usr/local/bin/devbox-storage cache-maintenance
EOF
cat > /etc/systemd/system/devbox-storage-sample.timer <<'EOF'
[Unit]
Description=Check disk pressure and growth every five minutes
[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
[Install]
WantedBy=timers.target
EOF
cat > /etc/systemd/system/devbox-storage-inventory.timer <<'EOF'
[Unit]
Description=Attribute disk usage to sessions every hour
[Timer]
OnBootSec=3min
OnUnitActiveSec=1h
[Install]
WantedBy=timers.target
EOF
for task in maintenance retention; do
  clock=04:20
  [ "$task" != retention ] || clock=05:10
  cat > "/etc/systemd/system/devbox-storage-$task.timer" <<EOF
[Unit]
Description=Daily devbox storage $task
[Timer]
OnCalendar=*-*-* $clock:00
RandomizedDelaySec=10min
Persistent=true
[Install]
WantedBy=timers.target
EOF
done
cat > /etc/systemd/system/devbox-storage-events.service <<'EOF'
[Unit]
Description=Refresh storage ownership after Docker session lifecycle events
After=docker.service
Requires=docker.service
[Service]
ExecStart=/usr/local/lib/devbox-storage/events.py
Restart=always
RestartSec=10
Nice=15
[Install]
WantedBy=multi-user.target
EOF
cat > /etc/systemd/system/devbox-storage-failure@.service <<'EOF'
[Unit]
Description=Report storage guard failure for %i
[Service]
Type=oneshot
ExecStart=/usr/local/lib/devbox-storage/failure.py %i
EOF
install -m 755 "$src/failure.py" "$dst/failure.py"
cat > /etc/logrotate.d/devbox-storage <<'EOF'
/var/log/devbox-backup.log {
    daily
    maxsize 50M
    rotate 7
    compress
    missingok
    notifempty
    copytruncate
    su root root
}
/var/lib/devbox-storage/actions.jsonl {
    weekly
    maxsize 20M
    rotate 12
    compress
    missingok
    notifempty
    copytruncate
    su root root
}
EOF
install -d /etc/systemd/journald.conf.d /etc/security/limits.d
cat > /etc/systemd/journald.conf.d/70-devbox-storage.conf <<'EOF'
[Journal]
SystemMaxUse=1G
SystemKeepFree=100G
MaxRetentionSec=14day
RuntimeMaxUse=256M
EOF
cat > /etc/security/limits.d/70-devbox-core.conf <<'EOF'
* soft core 0
* hard core 0
root soft core 0
root hard core 0
EOF
# Old Docker exec processes may inherit the original unlimited container hard
# limit. Drop core streams at the kernel boundary as well; no crash writes a
# multi-GiB file even in an old container. Existing files are left untouched.
cat > /etc/sysctl.d/70-devbox-core.conf <<'EOF'
kernel.core_pattern=|/bin/false
EOF
sysctl -p /etc/sysctl.d/70-devbox-core.conf
# This changes only future systemd child processes; no running service is restarted.
install -d /etc/systemd/system.conf.d
cat > /etc/systemd/system.conf.d/70-devbox-core.conf <<'EOF'
[Manager]
DefaultLimitCORE=0
EOF
systemctl daemon-reload
systemctl restart systemd-journald.service
# journal rotation applies the configured bound to old journal segments as well.
journalctl --rotate
journalctl --vacuum-size=1G
systemctl enable --now devbox-storage-sample.timer devbox-storage-inventory.timer devbox-storage-maintenance.timer devbox-storage-retention.timer devbox-storage-events.service
systemctl start --no-block devbox-storage-inventory.service
echo 'Storage guard installed; no devd, Docker or session restart.'
