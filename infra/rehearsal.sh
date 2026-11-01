#!/usr/bin/env bash
# devbox disaster-recovery rehearsal.
#   Full rehearsal (real fresh VM — OrbStack Linux VM or a Hetzner hourly box):
#     scp -r . root@<vm>:/opt/vps-dev-infra && ssh root@<vm> 'REPO_DIR=/opt/vps-dev-infra bash infra/bootstrap.sh'
#     then: tailscale up --ssh ; gh auth login ; open a `dev` session and `claude` login. Time it — target ~10 min.
#   --container: the CI-feasible subset (no systemd/tailscale/docker-in-docker) — verifies the repo boots devd and serves the API.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ "${1:-}" = "--container" ]; then
  docker run --rm -v "$PWD:/repo" -w /repo oven/bun:1 bash -c '
    set -e
    export DEVD_ROOT=/tmp/dev DEVD_CONFIG_DIR=/tmp/cfg DEVD_DB=/tmp/devd.sqlite \
           DEVD_SECRETS=/tmp/secrets.json DEVD_IMAGE=none DEVD_HOST=127.0.0.1 DEVD_PORT=4399 \
           DEVD_DASHBOARD_DIR=/tmp/nodash DEVD_CONTROL_ROOT=/tmp/ctl
    mkdir -p /tmp/cfg
    bun -e "import {saveConfig,DEFAULT_CONFIG} from \"./devd/src/config\"; saveConfig(\"/tmp/cfg/config.json\", DEFAULT_CONFIG)"
    bun devd/src/index.ts & sleep 2
    # oven/bun:1 (Debian trixie) ships no curl/wget — use bun'"'"'s built-in fetch instead.
    code=$(bun -e "try { const r = await fetch(\"http://localhost:4399/api/health\"); console.log(r.status); } catch (e) { console.log(\"000\"); }")
    kill %1 || true
    [ "$code" = "200" ] && echo "REHEARSAL OK: devd serves /api/health" || { echo "FAIL: health $code"; exit 1; }
  '
  exit 0
fi
echo "Use --container for the CI subset, or do a full rehearsal on a clean VM (see the header)."
