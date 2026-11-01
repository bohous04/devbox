#!/usr/bin/env bash
# Idempotently seed the devbox house guide into agent user-memory so every session in
# the container knows about srv/open/preview/prod-db. Four targets, because the agents
# read different files: Claude ~/.claude/CLAUDE.md, Codex $CODEX_HOME/AGENTS.md, Grok
# $GROK_HOME/AGENTS.md (same filename as Codex — measured via `grok inspect --json`,
# see the Grok research notes (2026-08-20)), Antigravity ~/.gemini/config/AGENTS.md
# (agy's global customization root, see the Antigravity research notes).
# Mirrors seed-warp-hooks / seed-devd-hooks: runs at container start, non-fatal,
# atomic write on the shared claude-home / codex-home / grok-home / antigravity-home volumes, and only ever
# touches its OWN block (delimited by the markers) — never other user content.
set -uo pipefail

GUIDE="${DEVBOX_GUIDE:-/opt/devbox/guide.md}"
BEGIN='<!-- BEGIN devbox-guide -->'
END='<!-- END devbox-guide -->'
HOME_DIR="${HOME:-/home/dev}"
TARGETS=(
  "${CLAUDE_CONFIG_DIR:-$HOME_DIR/.claude}/CLAUDE.md"
  "${CODEX_HOME:-$HOME_DIR/.codex}/AGENTS.md"
  "${GROK_HOME:-$HOME_DIR/.grok}/AGENTS.md"
  "${AGY_CONFIG:-$HOME_DIR/.gemini/config}/AGENTS.md"
)

# Nothing to seed on an older image without the guide — never fatal.
[ -s "$GUIDE" ] || exit 0

# The managed block: markers around the current guide content. Built once and reused,
# so both memory files always carry byte-identical instructions.
block="$(mktemp)" || exit 0
trap 'rm -f "$block"' EXIT
{ printf '%s\n' "$BEGIN"; cat "$GUIDE"; printf '%s\n' "$END"; } > "$block" || exit 0

# Writes the block into one memory file. Every failure returns instead of exiting, so an
# unwritable target (Codex home may not exist on an older volume) can't stop the other
# one from being seeded.
seed_into() {
  local dest="$1" tmp
  mkdir -p "$(dirname "$dest")" || return 0
  [ -e "$dest" ] || : > "$dest"
  tmp="$(mktemp "${dest}.XXXXXX")" || return 0

  if grep -qF "$BEGIN" "$dest" 2>/dev/null; then
    # Block present → replace everything between the markers (inclusive) with the
    # fresh block, in place; every other line stays untouched.
    awk -v b="$BEGIN" -v e="$END" -v blockfile="$block" '
      $0 == b { while ((getline line < blockfile) > 0) print line; close(blockfile); inblk=1; next }
      $0 == e { inblk=0; next }
      !inblk  { print }
    ' "$dest" > "$tmp" || { rm -f "$tmp"; return 0; }
  else
    # No block → prepend it, a blank line, then the existing file.
    { cat "$block"; printf '\n'; cat "$dest"; } > "$tmp" || { rm -f "$tmp"; return 0; }
  fi

  mv "$tmp" "$dest" || rm -f "$tmp"
}

for target in "${TARGETS[@]}"; do seed_into "$target"; done
