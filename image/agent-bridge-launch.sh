#!/usr/bin/env bash
# agent-bridge-launch — chat-runtime counterpart of agent-launch: prepares the account env for
# $DEVD_AGENT and keeps `agent-bridge serve` running. The loop is the supervisor: the bridge
# resumes its thread from /run/devd/bridge after a crash, so it is simply started again.
#
# Exit statuses of `agent-bridge serve` (src/serve.ts):
#   0  stopped on request (`stop` command)      -> the launcher exits
#   3  configuration error a restart cannot fix -> the launcher logs it once and exits
#   anything else (1 harness ended, 2 usage error, crash) -> restart with backoff (below)
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
  claude-gpt|claude-grok|claude-gemini|claude-openrouter)
    # Claude Code against a third-party upstream: no Anthropic account, so no lease (agent-launch takes none either);
    # the image's CLAUDE_CONFIG_DIR stays. `agent-bridge serve` turns the DEVD_* inputs into the profile env.
    ;;
  codex)
    # Installed next to this script, as for `co`.
    . "$(dirname -- "${BASH_SOURCE[0]}")/codex-account-env.sh"
    # Exports CODEX_HOME for a standalone account; the default account keeps the image's CODEX_HOME.
    codex_home_before=${CODEX_HOME:-}
    codex_account_prepare || { echo "agent-bridge-launch: Codex account preparation failed" >&2; exit 1; }
    # Chat sessions run on a per-account shadow home that shares threads/history/sqlite with every account
    # (so an account switch is a restart with thread/resume); auth.json stays the account's own, linked in place.
    codex_root=${DEVD_CODEX_ACCOUNTS_DIR:-/home/dev/.codex-accounts}
    codex_id=${DEVD_CODEX_ACCOUNT_ID:-}
    if [ -z "$codex_id" ]; then
      if [ "${CODEX_HOME:-}" = "$codex_home_before" ]; then
        codex_id=default # codex_account_prepare left CODEX_HOME alone: the default account
      elif [ "$(dirname -- "$CODEX_HOME")" = "$codex_root" ]; then
        codex_id=$(basename -- "$CODEX_HOME")
      else
        echo "agent-bridge-launch: cannot tell the Codex account from CODEX_HOME=$CODEX_HOME" >&2
        exit 1
      fi
    fi
    codex_shadow=$(agent-bridge codex-home "$codex_id") \
      || { echo "agent-bridge-launch: Codex shadow home for the account failed" >&2; exit 1; }
    export CODEX_HOME=$codex_shadow CODEX_SQLITE_HOME=$codex_shadow/sqlite DEVD_CODEX_ACCOUNT_ID=$codex_id
    ;;
  *)
    echo "agent-bridge-launch: unknown DEVD_AGENT \"${DEVD_AGENT:-}\" (chat sessions support claude, codex and the claude proxy profiles)" >&2
    exit 2
    ;;
esac

# Restart backoff: a run that fails within quick_secs is a quick failure; the delay doubles from 2 s to 60 s
# on consecutive quick failures and the launcher gives up after max_fails of them (e.g. a resume that fails on
# every start). A run that lasted longer resets both. The overrides exist for the launcher test.
quick_secs=${DEVBOX_BRIDGE_QUICK_SECS:-30}
max_fails=${DEVBOX_BRIDGE_MAX_FAILS:-5}
fails=0
delay=2
while :; do
  started=$SECONDS
  agent-bridge serve
  status=$?
  [ "$status" = 0 ] && exit 0
  if [ "$status" = 3 ]; then
    echo "agent-bridge-launch: agent-bridge serve has a configuration error (see above); not restarting" >&2
    exit 3
  fi
  if [ $((SECONDS - started)) -ge "$quick_secs" ]; then
    fails=0
    delay=2
  else
    fails=$((fails + 1))
    if [ "$fails" -ge "$max_fails" ]; then
      echo "agent-bridge-launch: agent-bridge failed $fails times in a row; giving up — the session shows as disconnected" >&2
      exit 1
    fi
  fi
  echo "agent-bridge-launch: agent-bridge serve exited with $status; restarting in $delay s" >&2
  sleep "$delay"
  if [ "$fails" -gt 0 ]; then
    delay=$((delay * 2))
    [ "$delay" -gt 60 ] && delay=60
  fi
done
