#!/usr/bin/env bash
# agent-launch [profile] [--print-agent] — starts the selected profile and consumes,
# once, the prompt from the devd control mount (/run/devd/prompt: rebase conflict,
# scheduled run). Profile selection: argument → $DEVD_AGENT → claude.
print=0
printenv=0
args=()
for a in "$@"; do
  case "$a" in
    --print-agent) print=1 ;;
    --print-env) printenv=1 ;;
    *) args+=("$a") ;;
  esac
done
# A profile is not the same as a binary: claude, claude-gpt and claude-grok all run `cc`,
# they differ only in the model (see devd/src/agents.ts, RUNTIME_BIN).
profile="${args[0]:-${DEVD_AGENT:-claude}}"
# Arguments AFTER the profile go to the binary (a live agent switch passes `--resume <id>`,
# see devd/src/agentSwitch.ts). Without an explicit profile the array is empty and the
# expansion below yields no word (the script does not run under set -u).
extra=("${args[@]:1}")
# The initial prompt usually goes to the binary as the last positional argument (claude/codex/
# grok read it that way). agy does not document this — its help only knows `-i, --prompt-interactive
# Run an initial prompt interactively and continue the session` — so a positional
# argument is not a guaranteed way to start a turn. The array is empty for
# all other profiles, leaving today's behavior unchanged (expanding an empty array
# without `set -u` yields no word, see the comment at `extra` above).
prompt_flag=()
case "$profile" in
  claude|claude-gpt|claude-grok|claude-gemini|claude-openrouter) bin=cc ;;
  codex) bin=co ;;
  grok)  bin=gr ;;
  antigravity) bin=ag; prompt_flag=(-i) ;;
  # Unknown value → claude, the session always starts. But not silently: a silent fallback
  # looks from outside like "I picked codex and claude started", which is indistinguishable
  # from a bug in devd. One sentence says what happened and what was entered wrong.
  # `${profile}` with braces on purpose: `$profile“` swallowed the first byte of the quote into
  # the variable name (bash 3.2 on the Mac does not count names in UTF-8) and the message then
  # printed nothing instead of the profile — exactly the information this sentence exists for.
  *) echo "devbox: unknown profile \"${profile}\" — starting claude." >&2; bin=cc; profile=claude ;;
esac
if [ "$print" = 1 ]; then echo "$profile"; exit 0; fi

# Profiles with a third-party model: Claude Code runs against a foreign upstream. Either against
# CLIProxyAPI on the host (holds OAuth to the subscriptions, billed to them), or directly
# against OpenRouter (a plain API key, no intermediary).
# Without a key or without a model there is no point starting — cc would fail only on the first
# request with a 401, which is incomprehensible from the user's point of view. We check both
# inputs separately because they have a different cause and a different fix (see below).
case "$profile" in
  claude-gpt|claude-grok|claude-gemini|claude-openrouter)
    # The canonical names are UPSTREAM_*, because the upstream need not be a proxy (OpenRouter
    # runs directly). The old CLIPROXY_* names are a fallback: a new image may run against an
    # older devd that still sends only those.
    upstream_url="${DEVD_UPSTREAM_URL:-${DEVD_CLIPROXY_URL:-}}"
    upstream_key="${DEVD_UPSTREAM_KEY:-${DEVD_CLIPROXY_KEY:-}}"
    if [ -z "$upstream_key" ]; then
      # Same symptom, but a completely different cause and fix per profile — so the
      # message must not be merged into one generic sentence. Wrong advice is worse than none:
      # sending someone to install a proxy because of a missing OpenRouter key makes them
      # search in a place where the cause is not.
      case "$profile" in
        claude-openrouter)
          echo "devbox: profile $profile needs an OpenRouter API key, but none arrived." >&2
          echo "devbox: add it in the dashboard (Subscriptions → OpenRouter) and open the" >&2
          echo "devbox: session again — no devd restart is needed for this." >&2
          ;;
        *)
          # devd reads the key from a file created by `install_cliproxy` — it has nothing to do
          # with the vault (it used to, and the message therefore sent people to unlock something
          # that never contained the key). Two causes remain and both are on the host, not here.
          echo "devbox: profile $profile needs a proxy key, but none arrived." >&2
          echo "devbox: CLIProxyAPI is probably not running on the host, or the key file is missing" >&2
          echo "devbox: (/etc/devd/cliproxy/api-key). Install the proxy via infra/setup.sh" >&2
          echo "devbox: and open the session again — no devd restart is needed for this." >&2
          ;;
      esac
      exec zsh
    fi
    # A different missing input, a different cause: the key arrived, but the profile has no model
    # assigned in the config (settings.proxyModels). Without a message this would lead to the same
    # opaque 401 as a missing key, just with a different fix.
    if [ -z "${DEVD_AGENT_MODEL:-}" ]; then
      echo "devbox: profile $profile has no model set (DEVD_AGENT_MODEL is empty)." >&2
      # Again two different places. Sending an OpenRouter profile "to the config" is worse than
      # staying silent: after saving from the card the model IS there, so the person opens the config,
      # sees the correct value and has nowhere to go next.
      case "$profile" in
        claude-openrouter)
          echo "devbox: set it in the dashboard (Subscriptions → OpenRouter) and open the session again." >&2
          ;;
        *)
          echo "devbox: add it to the devd config (settings.proxyModels) and open the session again." >&2
          ;;
      esac
      exec zsh
    fi
    if [ -z "$upstream_url" ]; then
      case "$profile" in
        claude-openrouter) upstream_url="https://openrouter.ai/api" ;;
        *) upstream_url="http://host.docker.internal:8317" ;;
      esac
    fi
    export ANTHROPIC_BASE_URL="$upstream_url"
    export ANTHROPIC_AUTH_TOKEN="$upstream_key"
    export ANTHROPIC_MODEL="$DEVD_AGENT_MODEL"
    export CLAUDE_CODE_SUBAGENT_MODEL="$DEVD_AGENT_MODEL"
    export CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY=3
    # xAI rejects requests with more than 350 tools, and the shared claude-home (11 MCP
    # servers) plus built-in tools adds up to over 500 — without tool search the session
    # sends NOT A SINGLE request (live 2026-08-23: "571 tools … maximum is 350").
    # Deferred loading via ToolSearch against grok worked, including loading and calling a
    # deferred tool (tool_reference blocks passed through both cliproxy and xAI). The other
    # proxy profiles stay at false: they work today and tool_reference passthrough of
    # their upstreams is not verified — do not enable across the board without a live test.
    # WARNING: devd/src/localEnv.ts is the TS mirror of this branch (dev local) — change them TOGETHER.
    case "$profile" in
      claude-grok) export ENABLE_TOOL_SEARCH=true ;;
      *)           export ENABLE_TOOL_SEARCH=false ;;
    esac
    # The model's context window (devd measures it via OpenRouter /v1/models): for an
    # unrecognized model cc assumes 200k and the session then keeps compacting — needlessly
    # for a model with a 1M window, and in an endless loop (measured 2026-08-22, stealth/ox-alpha).
    # Translated from the inert DEVD_AGENT_CTX only HERE: if devd passed CLAUDE_CODE_MAX_CONTEXT_TOKENS
    # straight into the container env, a native profile started next to it (`dev -n --claude`)
    # would inherit it too and would lie to cc about the window of a model devd does not know.
    [ -n "${DEVD_AGENT_CTX:-}" ] && export CLAUDE_CODE_MAX_CONTEXT_TOKENS="$DEVD_AGENT_CTX"
    # Marker for cc: do not attempt Remote Control (it is tied to Anthropic OAuth).
    export DEVBOX_PROXY_PROFILE=1
    ;;
esac
case "$profile" in
  claude-openrouter)
    # Background tasks in cc run on a small model. Without the override cc would request it
    # by a Haiku-family name, which OpenRouter does not have under this profile — either a 404
    # for every background operation, or (if it translated it to real Anthropic)
    # paid tokens on a profile that is otherwise free. Neither announces itself.
    export ANTHROPIC_SMALL_FAST_MODEL="$DEVD_AGENT_MODEL"
    # A subagent may ask for "Sonnet"/"Opus"/"Haiku" BY NAME — without remapping all
    # slots the session would request a model that is not on OpenRouter under this key
    # (404), or would silently escape to the paid Anthropic API. Same reason as
    # SMALL_FAST above, just for the remaining three slots.
    export ANTHROPIC_DEFAULT_SONNET_MODEL="$DEVD_AGENT_MODEL"
    export ANTHROPIC_DEFAULT_OPUS_MODEL="$DEVD_AGENT_MODEL"
    export ANTHROPIC_DEFAULT_HAIKU_MODEL="$DEVD_AGENT_MODEL"
    # cc prefers x-api-key over a bearer token, so an inherited ANTHROPIC_API_KEY
    # (from the image, from `docker -e`, left over from a native profile) would silently override our key
    # and OpenRouter would return 401 on a credential we never meant to send.
    # cliproxy profiles are DELIBERATELY left alone: they work today, so there is none there.
    unset ANTHROPIC_API_KEY
    ;;
esac
# Reasoning effort is a property of GPT models; do not force it on Grok.
[ "$profile" = claude-gpt ] && export CLAUDE_CODE_ALWAYS_ENABLE_EFFORT=1

if [ "$printenv" = 1 ]; then
  for v in ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN ANTHROPIC_API_KEY ANTHROPIC_MODEL \
           ANTHROPIC_SMALL_FAST_MODEL ANTHROPIC_DEFAULT_SONNET_MODEL ANTHROPIC_DEFAULT_OPUS_MODEL \
           ANTHROPIC_DEFAULT_HAIKU_MODEL CLAUDE_CODE_SUBAGENT_MODEL CLAUDE_CODE_MAX_CONTEXT_TOKENS \
           CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY ENABLE_TOOL_SEARCH CLAUDE_CODE_ALWAYS_ENABLE_EFFORT \
           DEVBOX_PROXY_PROFILE XAI_API_KEY; do
    [ -z "${!v:-}" ] && continue
    # ANTHROPIC_AUTH_TOKEN is the key to three paid subscriptions (proxy). --print-env
    # exists only so tests can peek into the exported environment, but
    # this script ships in the image — the value has nowhere to leak, but whatever is printable
    # to stdout can be found in production in `docker logs`/build cache too. The other variables
    # in the list are configuration, not secrets, so we print them unchanged.
    case "$v" in
      ANTHROPIC_AUTH_TOKEN|ANTHROPIC_API_KEY) echo "$v=<set>" ;;
      *) echo "$v=${!v}" ;;
    esac
  done
  exit 0
fi

# Label for the probe (`#{@devd_agent}`) — the attach picker and the manager then show which profile
# runs in that tmux session. Outside tmux (direct launch) this is a no-op.
tmux set @devd_agent "$profile" 2>/dev/null || true
export DEVD_LAUNCH_PROFILE="$profile"

# Anthropic account pool: devd says which profile to use. It returns only the profile name,
# no token. Empty output (devd absent, no account, missing mount) = fall back to the
# shared claude-home, i.e. today's behavior. Codex has its own mechanism (codex-home),
# so this is only for claude.
#
# WARNING: fail-open is not the same as removing the variable from the environment — the Dockerfile
# sets `ENV CLAUDE_CONFIG_DIR=/home/dev/.claude` (where claude-home is
# mounted) and THAT is already the correct fallback. Removing the variable would not
# return it to that default, it would send Claude elsewhere (`$HOME/.claude.json`
# instead of `$CLAUDE_CONFIG_DIR/.claude.json`, verified on claude 2.1.220) — i.e. into a
# profile without MCP servers (agent-sync writes them via
# `claude mcp add-json --scope user` precisely into `$CLAUDE_CONFIG_DIR/.claude.json`,
# see accountProfiles.ts), without the accepted trust dialog, without onboarding, and
# again on every recreate (review round 4, C1). So leave the variable unchanged
# when the lease returns nothing — the image ENV does the rest.
if [ "$profile" = claude ] && [ "${DEVD_RECOVERY_LAUNCH:-0}" != 1 ] && [ -x /usr/local/bin/account-lease ]; then
  pool_dir=$(/usr/local/bin/account-lease 2>/dev/null)
  if [ -n "$pool_dir" ]; then export CLAUDE_CONFIG_DIR="$pool_dir"; fi
fi

# DEVD_PROMPT_FILE is a test escape hatch (production always reads /run/devd/prompt) — tests
# have no right to write to /run.
PROMPT_FILE="${DEVD_PROMPT_FILE:-/run/devd/prompt}"
if [ "${DEVD_RECOVERY_LAUNCH:-0}" != 1 ] && [ -s "$PROMPT_FILE" ]; then
  prompt=$(cat "$PROMPT_FILE")
  rm -f "$PROMPT_FILE"
  # Antigravity before onboarding is finished: a typed prompt + Enter would run through the
  # onboarding menu and agree to data collection (checked by default). So we do not pass the prompt,
  # we only show it — the user finishes onboarding and pastes the task themselves.
  if [ "$profile" = antigravity ] && [ ! -e "${AGY_HOME:-$HOME/.gemini/antigravity-cli}/.devbox-onboarded" ]; then
    # A message on stderr disappears the moment agy starts full-screen over it
    # (TUI) — for a scheduled run with no live viewer the task would vanish without a trace.
    # So it is also saved to a file (overwritten, not appended — only the latest pending
    # task makes sense), so it can be found even after the terminal is closed.
    pending_dir="${AGY_HOME:-$HOME/.gemini/antigravity-cli}"
    pending_file="$pending_dir/.devbox-pending-prompt"
    mkdir -p "$pending_dir" 2>/dev/null
    : > "$pending_file"; chmod 600 "$pending_file" 2>/dev/null
    printf '%s' "$prompt" > "$pending_file"
    printf 'devbox: Antigravity is not set up yet — finish the initial setup in the terminal.\ndevbox: the prompt that was waiting: %s\ndevbox: also saved to %s\n' "$prompt" "$pending_file" >&2
    # Waits for Enter only when a real user is present (attached terminal) — otherwise
    # (scheduled run, tests) it could never continue.
    if [ -t 0 ]; then printf 'devbox: press Enter to continue…\n' >&2; read -r _; fi
    prompt=""; prompt_flag=()
  fi
  if [ -n "$prompt" ]; then "$bin" "${extra[@]}" "${prompt_flag[@]}" "$prompt"; else "$bin" "${extra[@]}"; fi
else
  "$bin" "${extra[@]}"
fi
if [ "${DEVD_RECOVERY_LAUNCH:-0}" = 1 ]; then
  unset DEVD_RECOVERY_LAUNCH DEVD_AGENT_AUTO_UPDATE
fi
unset DEVD_LAUNCH_PROFILE
# An agent that exits uncleanly (Codex remote client after "Disconnected from this task")
# leaves the pane in the alt screen with mouse reporting on. tmux then sends every mouse
# movement to zsh as text (`35;17;50M…`) and the session looks broken. Turn off X10/button/
# any-motion/SGR mouse and the alt screen; on a clean terminal these are no-ops.
printf '\033[?1000l\033[?1002l\033[?1003l\033[?1006l\033[?1049l'
exec zsh
