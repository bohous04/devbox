#!/usr/bin/env bash
set -euo pipefail
REPO_URL="${REPO_URL:-https://github.com/bohous04/devbox.git}"
REPO_DIR="${REPO_DIR:-/opt/vps-dev-infra}"
export REPO_DIR
[ -d "$REPO_DIR/.git" ] || git clone "$REPO_URL" "$REPO_DIR"
git -C "$REPO_DIR" pull --ff-only || true
bash "$REPO_DIR/infra/setup.sh"
