#!/usr/bin/env bash
set -euo pipefail
# With explicit args (e.g. `docker run devbox bash -lc ...`), behave like a
# normal entrypoint and run them instead of the session bootstrap.
if [ "$#" -gt 0 ]; then
  exec "$@"
fi
# Register the Warp cli-agent status hooks into the shared claude-home settings.json
# so this session's Claude Code state shows up in the Warp tab. Idempotent, non-fatal.
seed-warp-hooks 2>/dev/null || true

# Register the devd agent-event hooks (precise done/blocked notifications).
seed-devd-hooks 2>/dev/null || true

# Same for Codex (~/.codex/hooks.json): the same emitter, the same events.
seed-codex-hooks 2>/dev/null || true

# Same for Grok (~/.grok/hooks/devd.json — NOT ~/.grok/hooks.json, see seed-grok-hooks.sh):
# the same emitter, the same events.
# Unlike its neighbors, stderr is NOT DISCARDED here: this script has one known silent
# failure (unwritable grok-home → session without hooks and without explanation) and that single
# sentence must reach `docker logs`. Nothing else writes to stderr, so startup stays quiet.
seed-grok-hooks || true

# Same for Antigravity CLI (~/.gemini/config/hooks.json, a named hook `devd`).
# stderr is not discarded for the same reason as with grok: the single sentence about an unwritable
# volume must reach `docker logs`.
seed-agy-hooks || true

# Seed the devbox house guide into agent user-memory (Claude CLAUDE.md + Codex/Grok
# AGENTS.md) so every session knows about srv/open/preview/prod-db. Idempotent,
# non-fatal.
seed-devbox-guide 2>/dev/null || true

# git credentials: gh for github.com (if its config is mounted), devbox helper for the rest
if [ -d /home/dev/.config/gh ]; then gh auth setup-git 2>/dev/null || true; fi
git config --global credential.helper /usr/local/bin/git-credential-devbox
git config --global safe.directory /workspace

# Git via the devd proxy: the real token never enters the container, here there is only a dummy.
# `insteadOf` rewrites the address only at call time, so `git remote -v` stays readable
# and nothing changes in .git/config of existing repositories.
if [ -n "${DEVD_GIT_INSTEADOF:-}" ] && [ -n "${DEVD_URL:-}" ]; then
  base="${DEVD_URL%/}"
  IFS=',' read -ra _inst <<< "$DEVD_GIT_INSTEADOF"
  for pair in "${_inst[@]}"; do
    name="${pair%%=*}"; url="${pair#*=}"
    [ -n "$name" ] && [ -n "$url" ] || continue
    git config --global "url.${base}/git/${name}/.insteadOf" "${url%/}/" 2>/dev/null || true
  done
fi

# Start the main tmux session running the agent, then keep the container alive.
# `docker start` re-runs this, so a restarted container gets a fresh session
# (and agent-launch re-checks /run/devd/prompt — the conflict-prompt channel).
if [ -x /usr/local/bin/devbox-recovery ]; then
  recovery_status=0
  /usr/local/bin/devbox-recovery restore || recovery_status=$?
  if [ "$recovery_status" = 3 ]; then
    tmux new-session -d -s main -c /workspace /usr/local/bin/agent-launch || true
  elif [ "$recovery_status" != 0 ]; then
    # Preserve the old journal and show a shell; a new conversation would hide
    # that exact restoration failed.
    tmux new-session -d -s main -c /workspace zsh || true
  fi
  if [ "$recovery_status" = 0 ] || [ "$recovery_status" = 3 ]; then
    /usr/local/bin/devbox-recovery monitor &
  fi
else
  tmux new-session -d -s main -c /workspace /usr/local/bin/agent-launch || true
fi
# Status bar identity: replace #S with project/repo when devd passed DEVD_PROJECT/REPO
# (for older sessions without those env vars #S from tmux.conf stays). The server is already running (new-session).
if [ -n "${DEVD_PROJECT:-}" ]; then
  tmux set -g status-left " ${DEVD_PROJECT}/${DEVD_REPO:-} | " 2>/dev/null || true
fi
exec sleep infinity
