#!/usr/bin/env bash
# Idempotently seed the devbox house guide into agent user-memory so every session in
# the container knows about srv/open/preview/prod-db. Four targets, because the agents
# read different files: Claude ~/.claude/CLAUDE.md, Codex $CODEX_HOME/AGENTS.md, Grok
# $GROK_HOME/AGENTS.md (same filename as Codex — measured via `grok inspect --json`,
# see the Grok research notes (2026-08-20)), Antigravity ~/.gemini/config/AGENTS.md
# (agy's global customization root, see the Antigravity research notes).
# Mirrors seed-warp-hooks / seed-devd-hooks: runs at container start, non-fatal,
# atomic write on the shared claude-home / codex-home / grok-home / antigravity-home volumes, and only ever
# touches its OWN blocks (delimited by the markers) — never other user content.
# Two blocks: `devbox-guide` (the image's house guide) and `user-agents` (the user's own
# global AGENTS.md, see USER_GUIDE below).
set -uo pipefail

GUIDE="${DEVBOX_GUIDE:-/opt/devbox/guide.md}"
HOME_DIR="${HOME:-/home/dev}"
# The user's own global AGENTS.md. agent-sync copies it from the host's
# /etc/devd/config/AGENTS.md into the shared claude-home volume, which every container
# mounts at ~/.claude, so all four agents (and every account profile) get it on start.
# Missing or empty → its block is removed again.
USER_GUIDE="${DEVBOX_USER_GUIDE:-$HOME_DIR/.claude/devbox-user-agents.md}"
TARGETS=(
  "${CLAUDE_CONFIG_DIR:-$HOME_DIR/.claude}/CLAUDE.md"
  "${CODEX_HOME:-$HOME_DIR/.codex}/AGENTS.md"
  "${GROK_HOME:-$HOME_DIR/.grok}/AGENTS.md"
  "${AGY_CONFIG:-$HOME_DIR/.gemini/config}/AGENTS.md"
)

block="$(mktemp)" || exit 0
trap 'rm -f "$block"' EXIT

# Writes the managed block for one marker into one memory file. Every failure returns
# instead of exiting, so an unwritable target (Codex home may not exist on an older
# volume) can't stop the others from being seeded. An empty $block removes the block.
seed_into() {
  local dest="$1" begin="$2" end="$3" tmp
  # Removing a block from a file that doesn't exist is nothing to do; don't create it.
  [ -s "$block" ] || [ -e "$dest" ] || return 0
  mkdir -p "$(dirname "$dest")" || return 0
  [ -e "$dest" ] || : > "$dest"
  tmp="$(mktemp "${dest}.XXXXXX")" || return 0

  if grep -qF "$begin" "$dest" 2>/dev/null; then
    # Block present → replace everything between the markers (inclusive) with the
    # fresh block, in place; every other line stays untouched.
    awk -v b="$begin" -v e="$end" -v blockfile="$block" '
      $0 == b { while ((getline line < blockfile) > 0) print line; close(blockfile); inblk=1; next }
      $0 == e { inblk=0; next }
      !inblk  { print }
    ' "$dest" > "$tmp" || { rm -f "$tmp"; return 0; }
  elif [ -s "$block" ]; then
    # No block → prepend it, a blank line, then the existing file.
    { cat "$block"; printf '\n'; cat "$dest"; } > "$tmp" || { rm -f "$tmp"; return 0; }
  else
    rm -f "$tmp"; return 0
  fi

  mv "$tmp" "$dest" || rm -f "$tmp"
}

# seed <marker> <source file>: the block is the markers around the source, built once and
# reused so every memory file carries byte-identical instructions. A missing or empty
# source removes the block (and leaves the file alone if it never had one).
seed() {
  local begin="<!-- BEGIN $1 -->" end="<!-- END $1 -->" src="$2"
  if [ -s "$src" ]; then
    { printf '%s\n' "$begin"; cat "$src"; printf '%s\n' "$end"; } > "$block" || return 0
  else
    : > "$block" || return 0
  fi
  for target in "${TARGETS[@]}"; do seed_into "$target" "$begin" "$end"; done
}

# Nothing to seed on an older image without the guide — never fatal, and never strip it.
[ -s "$GUIDE" ] && seed devbox-guide "$GUIDE"
seed user-agents "$USER_GUIDE"
exit 0
