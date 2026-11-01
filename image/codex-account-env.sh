#!/usr/bin/env bash
# Sourced by co. Account selection happens only for an actual interactive launch.
# The default keeps its existing home and central Remote; other accounts own all
# of their auth, SQLite, writer locks, history and local app-server sockets.

codex_account_is_tui() {
  local arg
  while [ "$#" -gt 0 ]; do
    arg=$1; shift
    case "$arg" in
      --) return 0 ;;
      -h|--help|-V|--version|--remote|--remote=*) return 1 ;;
      -c|--config|--enable|--disable|-i|--image|-m|--model|--local-provider|-p|--profile|-s|--sandbox|-C|--cd|--add-dir|-a|--ask-for-approval|--remote-auth-token-env)
        [ "$#" -gt 0 ] && shift ;;
      -*) ;;
      exec|e|review|login|logout|mcp|plugin|mcp-server|app-server|remote-control|app|completion|update|doctor|sandbox|debug|apply|a|queue|archive|delete|migrate-rollouts|unarchive|cloud|exec-server|features|help|agents)
        return 1 ;;
      *)
        # Help for resume/fork is also a side-effect-free probe.
        for arg in "$@"; do
          case "$arg" in -h|--help|-V|--version) return 1 ;; --) break ;; esac
        done
        return 0 ;;
    esac
  done
  return 0
}

codex_account_valid_id() {
  [[ "$1" == default || "$1" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]
}

codex_account_resumes() {
  local arg
  while [ "$#" -gt 0 ]; do
    arg=$1; shift
    case "$arg" in
      --) return 1 ;;
      resume|fork|--continue|--resume) return 0 ;;
      -c|--config|--enable|--disable|-i|--image|-m|--model|--local-provider|-p|--profile|-s|--sandbox|-C|--cd|--add-dir|-a|--ask-for-approval)
        [ "$#" -gt 0 ] && shift ;;
      -*) ;;
      *) return 1 ;;
    esac
  done
  return 1
}

codex_account_available() {
  [ "$1" = default ] || { [ -d "$2/$1" ] && [ ! -L "$2/$1" ] && [ -s "$2/$1/auth.json" ]; }
}

codex_account_prepare() {
  CODEX_ACCOUNT_ARGS=()
  codex_account_is_tui "$@" || return 0
  local root=${DEVD_CODEX_ACCOUNTS_DIR:-/home/dev/.codex-accounts}
  local shared=${DEVD_CODEX_SHARED_HOME:-${CODEX_HOME:-$HOME/.codex}}
  local selected=${DEVD_CODEX_ACCOUNT_ID:-} origin=explicit available=default path id reply pane_value status detail
  local helper_dir
  helper_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd) || return 1

  if [ -z "$selected" ] && [ -n "${TMUX_PANE:-}" ]; then
    pane_value=$(tmux show-options -pqv -t "$TMUX_PANE" @devd_codex_account 2>/dev/null) || pane_value=
    if [ -n "$pane_value" ]; then selected=$pane_value; origin=pane; fi
  fi
  # An existing thread without an explicit/pane account belongs to the legacy
  # history. A changed automatic preference must not hide it during resume.
  if [ -z "$selected" ] && codex_account_resumes "$@"; then selected=default; origin=legacy; fi
  if [ -z "$selected" ]; then
    origin=automatic
    for path in "$root"/*; do
      id=${path##*/}
      if codex_account_valid_id "$id" && [ "$id" != default ] && codex_account_available "$id" "$root"; then
        available="$available,$id"
      fi
    done
    selected=default
    if [ -n "${DEVD_URL:-}" ]; then
      reply=$(curl --silent --connect-timeout 1 --max-time 3 --write-out '\n%{http_code}' \
        "${DEVD_URL%/}/api/codex-accounts/select?available=$available" 2>/dev/null) || reply=
      status=${reply##*$'\n'}
      reply=${reply%$'\n'*}
      case "$status" in
        ''|000|404|503) ;; # Offline/old devd: preserve the legacy default.
        200)
          id=$(printf '%s' "$reply" | jq -er '.accountId | select(type == "string")' 2>/dev/null) || id=
          if [ -z "$id" ] || ! codex_account_valid_id "$id" || ! codex_account_available "$id" "$root"; then
            echo "Codex: devd returned an invalid or unmounted account; automatic start was stopped." >&2
            return 1
          fi
          selected=$id ;;
        *)
          detail=$(printf '%s' "$reply" | jq -r '.error | select(type == "string") | gsub("[[:cntrl:]]"; " ") | .[0:300]' 2>/dev/null) || detail=
          echo "Codex: cannot select the account${detail:+: $detail}. Check the accounts in Subscriptions." >&2
          return 1 ;;
      esac
    fi
  fi
  if ! codex_account_valid_id "$selected"; then
    echo "Codex: invalid account ID. Use default or an account UUID from Subscriptions." >&2
    return 1
  fi
  if ! codex_account_available "$selected" "$root"; then
    echo "Codex: the selected account is not mounted or signed in in this container. Sign it in in Subscriptions; for a new mount, create a new session once you finish your work." >&2
    [ "$origin" != pane ] || echo "Codex: keeping this pane's account because of its history; open a new pane for a different account." >&2
    return 1
  fi

  if [ "$selected" = default ] && [ -n "${DEVD_CODEX_SHARED_HOME:-}" ] \
      && [ "${CODEX_HOME:-$shared}" != "$shared" ] && [ "${DEVD_CODEX_REMOTE:-1}" = 0 ]; then
    echo "Codex: this process inherited a standalone account's environment. Start the default account from a new terminal pane." >&2
    return 1
  fi

  if [ "$selected" != default ]; then
    # CLI overrides must not reconnect this profile to another account's state.
    local arg previous= value
    for arg in "$@"; do
      [ "$arg" != -- ] || break
      value=
      case "$arg" in --config=*) value=${arg#--config=} ;; -c?*) value=${arg#-c} ;; esac
      case "$previous" in -c|--config) value=$arg ;; esac
      if [[ "$value" =~ ^[[:space:]]*sqlite_home[[:space:]]*= ]]; then
        echo "Codex: sqlite_home cannot be overridden when using a standalone account." >&2
        return 1
      fi
      previous=$arg
    done
    path=$(cd -- "$root/$selected" && pwd -P) || return 1
    if [ "$path" = "$shared" ]; then
      echo "Codex: a standalone account must not use the shared CODEX_HOME." >&2
      return 1
    fi
    python3 "$helper_dir/codex-account-seed.py" "$shared" "$path" || return 1
    export CODEX_HOME=$path CODEX_SQLITE_HOME=$path DEVD_CODEX_REMOTE=0
    # Preserve the original shared path when co is invoked by a child process.
    export DEVD_CODEX_SHARED_HOME=$shared
    value=$(printf '%s' "$path" | jq -Rs .) || return 1
    CODEX_ACCOUNT_ARGS=(-c "sqlite_home=$value" -c 'cli_auth_credentials_store="file"')
    if command -v seed-codex-hooks >/dev/null 2>&1; then seed-codex-hooks || return 1; fi
  fi
  # Account identifiers only: never place credentials or labels in tmux state.
  if [ -n "${TMUX_PANE:-}" ]; then
    tmux set-option -p -t "$TMUX_PANE" @devd_codex_account "$selected" 2>/dev/null || true
  fi
}
