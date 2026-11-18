#!/usr/bin/env bash
# agent-bridge-launch — chat-runtime counterpart of agent-launch: prepares the account env for
# $DEVD_AGENT and keeps `agent-bridge serve` running. The loop is the supervisor: the bridge
# resumes its thread from /run/devd/bridge after a crash, so it is simply started again.
set -u

case "${DEVD_AGENT:-}" in
  claude)
    # Same as agent-launch: the lease prints a profile dir, or nothing and the image's
    # CLAUDE_CONFIG_DIR (shared claude-home) stays.
    if [ -x /usr/local/bin/account-lease ]; then
      pool_dir=$(/usr/local/bin/account-lease 2>/dev/null)
      if [ -n "$pool_dir" ]; then export CLAUDE_CONFIG_DIR="$pool_dir"; fi
    fi
    ;;
  codex)
    # Installed next to this script, as for `co`.
    . "$(dirname -- "${BASH_SOURCE[0]}")/codex-account-env.sh"
    # Exports CODEX_HOME for a standalone account; the default account keeps the image's CODEX_HOME.
    codex_account_prepare || { echo "agent-bridge-launch: Codex account preparation failed" >&2; exit 1; }
    ;;
  *)
    echo "agent-bridge-launch: unknown DEVD_AGENT \"${DEVD_AGENT:-}\" (chat sessions support claude and codex)" >&2
    exit 2
    ;;
esac

while :; do
  agent-bridge serve
  status=$?
  # 0 = the bridge was told to stop; anything else is a crash and the bridge comes back.
  [ "$status" = 0 ] && exit 0
  echo "agent-bridge-launch: agent-bridge serve exited with $status; restarting in 2 s" >&2
  sleep 2
done
