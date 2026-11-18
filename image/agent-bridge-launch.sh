#!/usr/bin/env bash
# agent-bridge-launch — chat-runtime counterpart of agent-launch: prepares the account env for
# $DEVD_AGENT and keeps `agent-bridge serve` running. The loop is the supervisor: the bridge
# resumes its thread from /run/devd/bridge after a crash, so it is simply started again.
#
# Exit statuses of `agent-bridge serve` (src/serve.ts):
#   0  stopped on request (`stop` command)      -> the launcher exits
#   3  configuration error a restart cannot fix -> the launcher logs it once and exits
#   anything else (1 harness ended, 2 usage error, crash) -> restart after 2 s
set -u

# Chat sessions get their state from the bridge; hooks would report the same agent a second time.
export DEVBOX_SKIP_HOOK_SEED=1

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
  [ "$status" = 0 ] && exit 0
  if [ "$status" = 3 ]; then
    echo "agent-bridge-launch: agent-bridge serve has a configuration error (see above); not restarting" >&2
    exit 3
  fi
  echo "agent-bridge-launch: agent-bridge serve exited with $status; restarting in 2 s" >&2
  sleep 2
done
