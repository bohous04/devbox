#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
bash -n setup.sh && bash -n bootstrap.sh && echo "syntax OK"
command -v shellcheck >/dev/null && shellcheck -x setup.sh bootstrap.sh || echo "shellcheck not installed — skipped"
# idempotency of the non-privileged helpers in a throwaway dir
DEVD_ROOT="$(mktemp -d)"
export DEVD_ROOT
# shellcheck disable=SC1091
source setup.sh
make_structure; make_structure   # must be safe to run twice
test -d "$DEVD_ROOT/apps" && test -d "$DEVD_ROOT/websites" && echo "structure OK"
# config seed: with no CONFIG_REPO, fetch_config must write a default config.json.
# harness cwd is infra/ (cd above); REPO_DIR is the repo root so bun resolves ./devd/src/config
CONFIG_DIR="$(mktemp -d)/cfg"
REPO_DIR="$(dirname "$PWD")"
export REPO_DIR   # consumed by fetch_config (sourced); export so SC2034 sees the use
fetch_config
test -f "$CONFIG_DIR/config.json" && echo "config seed OK"
bash test-codex-plugin-keeper.sh
bash test-mcp-oom-guard.sh
python3 -m unittest discover -s codex-remote -p 'test_native_update.py'
# optional components are opt-in via DEVBOX_FEATURES
( DEVBOX_FEATURES=""; ! has_feature samba ) && ( DEVBOX_FEATURES="op samba"; has_feature samba && ! has_feature cliproxy ) \
  && ( DEVBOX_FEATURES="all"; has_feature cliproxy && has_feature storage-guard ) && echo "features OK"
