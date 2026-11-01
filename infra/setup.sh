#!/usr/bin/env bash
set -euo pipefail

DEVD_ROOT="${DEVD_ROOT:-/srv/dev}"
REPO_DIR="${REPO_DIR:-/opt/vps-dev-infra}"
CONFIG_DIR="${DEVD_CONFIG_DIR:-/etc/devd/config}"
CONFIG_REPO="${CONFIG_REPO:-}"          # optional git URL of a private config repo (config.json)
LISTENER_URL="${LISTENER_URL:-}"        # e.g. http://<mac-tailscale-ip>:7777 — empty disables Mac notifications/open
# Top-level folders under $DEVD_ROOT (space separated). Projects inside them live in config.json.
read -r -a FOLDERS <<< "${DEVD_FOLDERS:-apps websites}"

# Optional components (space separated, or "all"). The core — Docker, Bun, git, jq, ufw,
# Tailscale, gh, devd, dashboard, the session image — is always installed.
#   samba        SMB share of $DEVD_ROOT over the tailnet (Finder on a Mac)
#   cloudflared  Cloudflare Tunnel binary for exposing the dashboard (tunnel itself is manual)
#   op           1Password CLI; devd brokers SSH keys to sessions with an op service account
#   cliproxy     local proxy for subscription-backed proxy profiles (see docs/account-pool.md)
#   storage-guard  disk/session budgets, offsite-verified cleanup (infra/storage-guard; needs borg)
DEVBOX_FEATURES="${DEVBOX_FEATURES:-}"
has_feature() { [[ " $DEVBOX_FEATURES " == *" all "* || " $DEVBOX_FEATURES " == *" $1 "* ]]; }

log() { echo "▶ $*"; }

install_packages() {
  local pkgs=(ca-certificates curl gnupg jq ufw unzip git openssl)
  has_feature samba && pkgs+=(samba)
  local missing=()
  for p in "${pkgs[@]}"; do dpkg -s "$p" >/dev/null 2>&1 || missing+=("$p"); done
  [ "${#missing[@]}" -eq 0 ] && return 0
  apt-get update -y
  apt-get install -y --no-install-recommends "${missing[@]}"
}

install_gh() {
  # gh is not in Debian's default repos (unlike Ubuntu universe) — install from the official apt repo (works on both)
  command -v gh >/dev/null && return 0
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli.gpg
  chmod go+r /etc/apt/keyrings/githubcli.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list
  apt-get update -y
  apt-get install -y --no-install-recommends gh
}

install_docker() {
  command -v docker >/dev/null && return 0
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
}

install_op() {
  # 1Password CLI on the HOST — devd uses it (with secrets.opServiceAccountToken) to broker
  # SSH keys to containers via /api/op. The token never enters a container.
  has_feature op || return 0
  command -v op >/dev/null && return 0
  local arch; arch="$(dpkg --print-architecture)"
  curl -sSfLo /tmp/op.zip "https://cache.agilebits.com/dist/1P/op2/pkg/v2.34.0/op_linux_${arch}_v2.34.0.zip"
  unzip -o /tmp/op.zip op -d /usr/local/bin/ && rm -f /tmp/op.zip && chmod 755 /usr/local/bin/op
}

install_cloudflared() {
  # Binary only — the tunnel itself is connected manually with a per-deployment token:
  #   cloudflared service install <TOKEN>   (token + public hostname + Access set in the CF dashboard)
  has_feature cloudflared || return 0
  command -v cloudflared >/dev/null && return 0
  install -d -m 0755 /usr/share/keyrings
  curl -fsSL https://pkg.cloudflare.com/cloudflare-public-v2.gpg > /usr/share/keyrings/cloudflare-public-v2.gpg
  echo "deb [signed-by=/usr/share/keyrings/cloudflare-public-v2.gpg] https://pkg.cloudflare.com/cloudflared any main" > /etc/apt/sources.list.d/cloudflared.list
  apt-get update -y && apt-get install -y --no-install-recommends cloudflared
}

install_bun() {
  command -v bun >/dev/null && return 0
  curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash
}

install_tailscale() {
  command -v tailscale >/dev/null && return 0
  curl -fsSL https://tailscale.com/install.sh | sh
  log "Run manually: tailscale up --ssh   (and approve it in the browser)"
}

configure_ufw() {
  # Allow the port sshd actually listens on, not a hardcoded 22 — otherwise a re-run
  # (the runbook asks for one after `tailscale up`) resets ufw and drops a hardened
  # non-standard SSH port (e.g. 2222 from the hardening role), locking you out.
  local ssh_port; ssh_port="$(sshd -T 2>/dev/null | awk '/^port /{print $2; exit}' || true)"; ssh_port="${ssh_port:-22}"
  ufw --force reset
  ufw default deny incoming
  ufw default allow outgoing
  ufw allow 41641/udp comment 'tailscale'
  # devd runs natively on the host, so traffic from containers goes through the INPUT chain
  # and ufw has to allow it. With dind every session has its OWN bridge network
  # `dind-net-<session>` (interface `br-…`, not docker0), so `allow in on docker0` would
  # silently drop container SYNs: hooks hang on curl timeouts, notifications and the
  # srv/open/preview/db-request shims stop working. ufw has no interface wildcards, hence
  # the rules match the SOURCE range — both default docker address pools (172.16.0.0/12 for
  # the first 15 networks, then 192.168.0.0/16). The deny on eth0 comes FIRST on purpose:
  # eth0 has rp_filter=2 (loose), so a spoofed private source from the internet would
  # otherwise match the allow. Rule order = evaluation order in ufw.
  ufw deny in on eth0 to any port 4300 proto tcp comment 'devd api: never from internet'
  ufw allow from 172.16.0.0/12 to any port 4300 proto tcp comment 'containers (all docker bridges) → devd api'
  ufw allow from 192.168.0.0/16 to any port 4300 proto tcp comment 'containers (docker 2nd default pool) → devd api'
  # dind session networks get their own /24 from 10.213.0.0/16 (dind.ts dindSubnetCandidates).
  ufw allow from 10.213.0.0/16 to any port 4300 proto tcp comment 'containers (dind networks 10.213/16) -> devd api'
  # Same for the prod-db DB proxy (DEVD_DB_PROXY_PORT): psql in a container connects to the
  # host address and ufw would otherwise drop the SYN from the dind network.
  ufw deny in on eth0 to any port 15432 proto tcp comment 'devd db proxy: never from internet'
  ufw allow from 172.16.0.0/12 to any port 15432 proto tcp comment 'containers (all docker bridges) → devd db proxy'
  ufw allow from 192.168.0.0/16 to any port 15432 proto tcp comment 'containers (docker 2nd default pool) → devd db proxy'
  ufw allow from 10.213.0.0/16 to any port 15432 proto tcp comment 'containers (dind networks 10.213/16) -> devd db proxy'
  # MariaDB speaks a server-first protocol, so it has its own bridge listener.
  ufw deny in on eth0 to any port 15433 proto tcp comment 'devd MariaDB proxy: never from internet'
  ufw allow from 172.16.0.0/12 to any port 15433 proto tcp comment 'containers -> devd MariaDB proxy'
  ufw allow from 192.168.0.0/16 to any port 15433 proto tcp comment 'containers second pool -> devd MariaDB proxy'
  ufw allow from 10.213.0.0/16 to any port 15433 proto tcp comment 'containers (dind networks 10.213/16) -> devd MariaDB proxy'
  # devd VM listener for InstaBox machines (DEVD_VM_PORT, default 4301): only hooks, OTel, git
  # proxy, health and lease (devd/src/vmListener.ts). Only from the tailnet; not from containers on the VPS.
  ufw deny in on eth0 to any port 4301 proto tcp comment 'devd VM listener: nikdy z internetu'
  ufw allow in on tailscale0 to any port 4301 proto tcp comment 'devd VM listener (InstaBox, tailnet)'
  if has_feature samba; then
    ufw allow in on tailscale0 to any port 445 proto tcp comment 'samba (tailnet)'
    ufw allow in on tailscale0 to any port 139 proto tcp comment 'samba (tailnet)'
  fi
  ufw allow "${ssh_port}/tcp" comment 'ssh'   # key-only + fail2ban make this a safe break-glass alongside Tailscale SSH
  ufw --force enable
}

configure_docker_firewall() {
  # ufw alone is not enough for containers — docker writes its own rules around it (see
  # docker-user-firewall.sh). The unit is PartOf=docker.service, so the rule is restored
  # after a docker restart too, not just after boot.
  install -m 755 "$REPO_DIR/infra/docker-user-firewall.sh" /usr/local/sbin/docker-user-firewall.sh
  cp "$REPO_DIR/infra/docker-user-firewall.service" /etc/systemd/system/docker-user-firewall.service
  systemctl daemon-reload
  systemctl enable --now docker-user-firewall.service
}

configure_samba() {
  # smbd binds all interfaces; tailnet-only access is enforced by ufw (see configure_ufw).
  has_feature samba || return 0
  cp "$REPO_DIR/infra/smbd-devbox.conf" /etc/samba/smb.conf
  systemctl enable smbd >/dev/null 2>&1 || true
  systemctl restart smbd
  log "Don't forget: smbpasswd -a root to set the SMB password (Finder login)"
}

make_structure() {
  mkdir -p "$DEVD_ROOT"
  for f in "${FOLDERS[@]}"; do mkdir -p "$DEVD_ROOT/$f"; done
  chown -R 1000:1000 "$DEVD_ROOT" 2>/dev/null || true
}

fetch_config() {
  mkdir -p "$CONFIG_DIR"
  if [ -d "$CONFIG_DIR/.git" ]; then git -C "$CONFIG_DIR" pull --ff-only || true
  elif [ -n "$CONFIG_REPO" ]; then git clone "$CONFIG_REPO" "$CONFIG_DIR"; fi
  if [ ! -f "$CONFIG_DIR/config.json" ]; then
    (cd "$REPO_DIR" && bun -e "import {saveConfig,DEFAULT_CONFIG} from \"./devd/src/config\"; saveConfig(\"$CONFIG_DIR/config.json\", DEFAULT_CONFIG)")
  fi
}

# After the build the image is "pinned" by a tiny long-running container: a freshly rebuilt
# devbox:latest has no container until the first session starts, so any periodic
# `docker image prune -a` (e.g. Coolify's nightly cleanup) sees it as unused and deletes it,
# which breaks starting sessions and scheduled jobs. A running keeper keeps it "in use".
build_image() {
  # Image timezone = host timezone (devd also passes it to containers at runtime, see DEVD_TZ).
  docker build --build-arg TZ="$(timedatectl show -p Timezone --value 2>/dev/null || echo UTC)" -t devbox:latest "$REPO_DIR/image"
  docker rm -f devbox-image-keeper >/dev/null 2>&1 || true
  docker run -d --name devbox-image-keeper --restart unless-stopped \
    --entrypoint sleep devbox:latest infinity >/dev/null
}

install_cc() { install -m 755 "$REPO_DIR/infra/cc-host" /usr/local/bin/cc; }

build_dashboard() { (cd "$REPO_DIR" && bun install && bun run build:dashboard); }

install_devd_service() {
  # `|| true` inside the substitution: tailscale not-yet-up makes the pipe fail, and under
  # `set -e -o pipefail` a bare assignment from a failing $() aborts BEFORE the fallback runs.
  local ip; ip="$(tailscale ip -4 2>/dev/null | head -1 || true)"; [ -n "$ip" ] || ip=127.0.0.1
  sed -e "s#__REPO__#$REPO_DIR#g" -e "s#__IP__#$ip#g" -e "s#__LISTENER__#${LISTENER_URL:-}#g" "$REPO_DIR/infra/devd.service" > /etc/systemd/system/devd.service
  mkdir -p /var/lib/devd
  systemctl daemon-reload
  systemctl enable devd
  systemctl restart devd
  if [ "$ip" = "127.0.0.1" ]; then
    log "⚠️ No Tailscale IP yet — devd listens on 127.0.0.1. After 'tailscale up --ssh' run again: sudo REPO_DIR=$REPO_DIR bash $REPO_DIR/infra/setup.sh"
  fi
}

prepare_instabox_dirs() {
  # InstaBox overflow (infra/instabox/README.md): machine key + certificates, API/Tailscale key
  # files (outside the vault — pause/resume must work even with a locked vault) and an include
  # for ssh, so `docker -H ssh://ibx-…` works even from `ssh vps` (CLI attach from the mac).
  install -d -m 0700 /var/lib/devd/instabox /var/lib/devd/instabox/hosts /etc/devd/instabox
  install -d -m 0755 /etc/ssh/ssh_config.d
  grep -q '^Include /etc/ssh/ssh_config.d/\*.conf' /etc/ssh/ssh_config || sed -i '1i Include /etc/ssh/ssh_config.d/*.conf' /etc/ssh/ssh_config
}

install_cliproxy() {
  has_feature cliproxy || return 0
  # The docker0 gateway must NOT be hardcoded: a host with a different bridge network has a
  # different one, and the proxy would be unreachable from containers (or bind too widely).
  # `2>/dev/null || true`: under `set -euo pipefail` a docker failure would otherwise abort
  # the whole setup before the guard below runs.
  local gw
  gw=$(docker network inspect bridge -f '{{(index .IPAM.Config 0).Gateway}}' 2>/dev/null || true)
  [ -n "$gw" ] || { log "skipped: could not determine the docker0 gateway"; return; }
  mkdir -p /etc/devd/cliproxy
  [ -f /etc/devd/cliproxy/config.yaml ] || {
    # The placeholder in the example config is replaced with a real random key right away,
    # so a fresh install is safe without a manual step (otherwise the proxy would listen
    # with a key that is public in this repo). The key never hits argv or the terminal:
    #  1) files are created 0600 up front (`install -m 600 /dev/null`), not chmod-ed later;
    #  2) sed gets its expression on STDIN (`-f -`), because argv is readable via `ps`;
    #  3) the key is not printed — devd reads it from the `api-key` file created here.
    local key; key=$(openssl rand -hex 32)
    install -m 600 /dev/null /etc/devd/cliproxy/config.yaml
    install -m 600 /dev/null /etc/devd/cliproxy/api-key
    printf '%s\n' "$key" > /etc/devd/cliproxy/api-key
    printf 's#__CHANGE_ME__#%s#\n' "$key" \
      | sed -f - "$REPO_DIR/infra/cliproxy-config.example.yaml" > /etc/devd/cliproxy/config.yaml
    log "generated a new cliproxy key in /etc/devd/cliproxy/api-key (devd reads it itself)"
  }
  # Upgrade path for installs created before devd read the key from a file: the block above
  # is skipped (config.yaml exists), so api-key would never be created. Extract it from the
  # existing config instead.
  if [ ! -s /etc/devd/cliproxy/api-key ] && [ -f /etc/devd/cliproxy/config.yaml ]; then
    local existing
    existing=$(sed -n 's/^[[:space:]]*-[[:space:]]*"\(.*\)"[[:space:]]*$/\1/p' /etc/devd/cliproxy/config.yaml | head -1)
    if [ -n "$existing" ] && [ "$existing" != "__CHANGE_ME__" ]; then
      install -m 600 /dev/null /etc/devd/cliproxy/api-key
      printf '%s\n' "$existing" > /etc/devd/cliproxy/api-key
      log "created /etc/devd/cliproxy/api-key from the existing config.yaml"
    fi
  fi
  sed -e "s#__DOCKER_GW__#$gw#g" "$REPO_DIR/infra/cliproxy.service" > /etc/systemd/system/cliproxy.service
  ufw allow in on docker0 to any port 8317 proto tcp comment 'containers → cliproxy'
  systemctl daemon-reload
  # Enable BEFORE the placeholder guard below, otherwise the proxy would silently not come
  # up after a reboot. Enabling a unit whose config still has the placeholder is safe
  # because cliproxy.service has an ExecStartPre that refuses to start in that case.
  systemctl enable cliproxy
  # Belt and braces: config.yaml can be edited by hand and keep the placeholder. A stopped
  # proxy is the safe outcome — one with a publicly known key would be an open relay.
  if grep -q '__CHANGE_ME__' /etc/devd/cliproxy/config.yaml; then
    log "⚠️ cliproxy NOT started: /etc/devd/cliproxy/config.yaml still has the placeholder api-keys — replace it with a real key and run: systemctl start cliproxy"
    return
  fi
  # `restart`, not `enable --now`: `--now` leaves a running unit alone, so a re-run after
  # the docker0 gateway changed would write a new unit file that never takes effect.
  systemctl restart cliproxy
}

install_devd_watch() {
  # Host-side timer that checks from the outside that devd is alive. A locked vault is
  # reported by devd itself through the app (vaultNotifier.ts); the watchdog only carries it
  # in the Kuma heartbeat. It must NOT go through devd /api/notify: when devd is down that
  # path is silent exactly when it matters. The Pushover credentials live in the vault, so it
  # reads its own copy from /etc/devd/watch.env — without that file it is not installed.
  if [ ! -f /etc/devd/watch.env ]; then
    echo "  skipped: /etc/devd/watch.env is missing (PUSHOVER_TOKEN, PUSHOVER_USER)" >&2
    return 0
  fi
  cp "$REPO_DIR/infra/devd-watch.service" /etc/systemd/system/devd-watch.service
  cp "$REPO_DIR/infra/devd-watch.timer" /etc/systemd/system/devd-watch.timer
  systemctl daemon-reload
  systemctl enable --now devd-watch.timer
}

install_oom_guard() {
  # Protection against one session (a runaway `next dev`, headless Chrome) eating up
  # the RAM of the whole server — on 2 Oct 2026 that ended with a stuck box and a reset from the netcup SCP.
  # Layers: a 15 GB RAM + 20 GB swap cap per session (devd + this timer as a safeguard), a cap on the shared
  # Codex, earlyoom ahead of the kernel OOM, and protecting ssh/tailscale/devd from the OOM killer.
  local d="$REPO_DIR/infra/oom-guard" unit
  apt-get install -y --no-install-recommends earlyoom
  cp "$d/earlyoom.default" /etc/default/earlyoom
  install -m 755 "$d/devbox-memcap.sh" /usr/local/sbin/devbox-memcap
  cp "$d/devbox-memcap.service" /etc/systemd/system/devbox-memcap.service
  cp "$d/devbox-memcap.timer" /etc/systemd/system/devbox-memcap.timer
  for unit in ssh tailscaled devd; do
    install -d -m 0755 "/etc/systemd/system/$unit.service.d"
    cp "$d/oom-protect.conf" "/etc/systemd/system/$unit.service.d/50-oom-protect.conf"
  done
  install -d -m 0755 /etc/systemd/system/codex-remote-control.service.d
  cp "$d/codex-remote-control-memory.conf" /etc/systemd/system/codex-remote-control.service.d/40-memory.conf
  # Raises oom_score_adj for the agent's descendants → when a container is full, the subagents'
  # MCP servers die, not the main codex/claude.
  install -m 755 "$REPO_DIR/infra/mcp-oom-guard.sh" /usr/local/bin/mcp-oom-guard
  cp "$REPO_DIR/infra/mcp-oom-guard.service" /etc/systemd/system/mcp-oom-guard.service
  cp "$REPO_DIR/infra/mcp-oom-guard.timer" /etc/systemd/system/mcp-oom-guard.timer
  systemctl daemon-reload
  systemctl enable --now devbox-memcap.timer mcp-oom-guard.timer
  systemctl enable earlyoom
  systemctl restart earlyoom
}

install_codex_plugin_keeper() {
  # Host-side timer: when a plugin update deletes the old version from the shared Codex
  # cache, replace it with a symlink to the new one — otherwise a running app-server
  # reports "Hook failed … 127".
  install -m 755 "$REPO_DIR/infra/codex-plugin-keeper.sh" /usr/local/bin/codex-plugin-keeper
  cp "$REPO_DIR/infra/codex-plugin-keeper.service" /etc/systemd/system/codex-plugin-keeper.service
  cp "$REPO_DIR/infra/codex-plugin-keeper.timer" /etc/systemd/system/codex-plugin-keeper.timer
  systemctl daemon-reload
  systemctl enable --now codex-plugin-keeper.timer
}

install_codex_native_update() {
  # Host-side timer: the central Codex app-server is a custom build (native.patch). Without
  # this it would stay on an old version and the server would reject new models for it. It builds the new
  # version and switches to it at night, when no thread is working (infra/codex-remote/native-build.md).
  cp "$REPO_DIR/infra/codex-remote/codex-native-update.service" /etc/systemd/system/codex-native-update.service
  cp "$REPO_DIR/infra/codex-remote/codex-native-update.timer" /etc/systemd/system/codex-native-update.timer
  systemctl daemon-reload
  systemctl enable --now codex-native-update.timer
}

disable_codex_remote() {
  # The central Codex Remote server has been disabled since 14 Oct 2026: co runs locally in the container
  # (image/co). The server and its helper timers are kept stopped so a redeploy does not revive them.
  local unit
  for unit in codex-remote-control.service codex-devbox-catalog.service \
      codex-native-update.timer codex-plugin-keeper.timer; do
    systemctl disable --now "$unit" 2>/dev/null || true
  done
  rm -f /var/lib/docker/volumes/codex-home/_data/app-server-control/app-server-control.sock
}

install_codex_yolo_defaults() {
  # Codex Remote rejects permission overrides on resume (`co resume` cannot send yolo),
  # so full access must be the default in the server config. The container is the sandbox.
  local cfg=/var/lib/docker/volumes/codex-home/_data/config.toml
  [ -f "$cfg" ] || return 0
  python3 - "$cfg" <<'PY'
import sys
p = sys.argv[1]; s = open(p).read()
head, sep, rest = s.partition("\n[")
add = [k for k in ('approval_policy = "never"', 'sandbox_mode = "danger-full-access"') if k.split(" =")[0] not in head]
if add:
    open(p, "w").write(head.rstrip("\n") + "\n" + "\n".join(add) + "\n" + sep + rest)
PY
}

install_storage_guard() {
  # Budgets and backup-verified cleanup for session storage. Wraps the host docker CLI and
  # needs borg + an offsite repo in /etc/devbox-storage/config.json (see its README).
  has_feature storage-guard || return 0
  command -v borg >/dev/null || { apt-get update -y && apt-get install -y --no-install-recommends borgbackup; }
  bash "$REPO_DIR/infra/storage-guard/install.sh"
}

provision_claude() {
  (cd "$REPO_DIR" && DEVD_CONFIG_DIR="$CONFIG_DIR" bun tools/agent-sync.ts) || log "agent-sync failed — run it again after claude/codex login"
}

main() {
  install_packages; install_gh; install_docker; install_cloudflared; install_op; install_bun; install_tailscale
  configure_ufw; configure_docker_firewall; configure_samba; make_structure; fetch_config
  build_image; install_cc; build_dashboard; install_devd_service; prepare_instabox_dirs; install_cliproxy; install_devd_watch; install_oom_guard; disable_codex_remote; install_codex_yolo_defaults; install_storage_guard; provision_claude
  log "Done (features: ${DEVBOX_FEATURES:-core only}). Remaining: tailscale up --ssh · gh auth login · claude login (in the first session)"
  has_feature samba && log "Samba: smbpasswd -a root"
  log "Security: once tailscale ssh works, consider closing public SSH: ufw delete allow <ssh-port>/tcp"
  log "After 'tailscale up --ssh' run again (rebinds devd to the tailnet): sudo REPO_DIR=$REPO_DIR bash $REPO_DIR/infra/setup.sh"
}

# only run main when executed, not when sourced (so tests can source helpers)
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then main "$@"; fi
