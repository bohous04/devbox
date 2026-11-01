#!/usr/bin/env bash
# link-shared-profile <profile> <shared-readable> <symlink-target> [seed-.claude.json]
#
# The SINGLE source of truth about what in an account profile is its own and what is shared. Used
# by the mac (from the checkout, after `claude auth login`) and by the devbox (from the image, via an
# ephemeral container). If it were written twice, the two sides would drift apart.
#
# Shared history across accounts is an explicit user requirement: `projects/` and co.
# are symlinks, so `claude --continue` sees a conversation started under the other account.
#
# MIND THE ORDER: on the mac this runs only AFTER `claude auth login`. If the symlinks
# existed beforehand, login would write through them into the shared profile and the accounts
# would get crossed.
#
# <shared-readable> and <symlink-target> differ only in the ephemeral container: reads go
# through /shared, but the link must point to where the volume will be mounted in the session container
# (/home/dev/.claude). On the mac both are ~/.claude.
set -eu

if [ $# -lt 3 ]; then
  echo "usage: link-shared-profile <profile> <shared-readable> <symlink-target> [seed-.claude.json]" >&2
  exit 2
fi
profile="$1"; shared="$2"; target="$3"; seed="${4:-}"

# `$# -lt 3` checks only the NUMBER of arguments — "" as a value would slip through silently. An empty
# `profile`/`shared`/`target` would then end up in paths (mkdir -p "", ln -sfn "/…") and the
# script would either do nothing or create dead links in the filesystem root, both
# with exit 0. Fail loudly, not silently onward with an empty variable.
if [ -z "$profile" ] || [ -z "$shared" ] || [ -z "$target" ]; then
  echo "usage: link-shared-profile <profile> <shared-readable> <symlink-target> [seed-.claude.json] — the first three arguments must not be empty" >&2
  exit 2
fi
if [ ! -d "$shared" ]; then
  echo "link-shared-profile: shared directory '$shared' does not exist or is not a directory" >&2
  exit 2
fi

# Verified split: per account there are only .credentials.json and .claude.json (sessions/ and
# backups/ the profile creates itself), everything else is a symlink.
SHARED_ITEMS="settings.json CLAUDE.md notify.js statusline-command.sh
agents rules skills plugins
projects history.jsonl file-history session-env shell-snapshots tasks teams"

mkdir -p "$profile"

# THE ORDER IS NOT JUST DOCUMENTED, IT IS ENFORCED: `claude auth login` on the mac populates the
# profile (among other things it creates .credentials.json). If linking happened EARLIER, the symlinks
# would not exist yet at that moment (login runs against real files), but the order is
# exactly the thing that is easiest to "optimize away" a year from now — hence a guard, not just
# a comment. Without .credentials.json the profile has not been through login yet and must not be linked.
if [ ! -s "$profile/.credentials.json" ]; then
  echo "link-shared-profile: '$profile' has no .credentials.json — the profile has not been logged in yet, link it only AFTER 'claude auth login'" >&2
  exit 5
fi

# Anything in the profile in place of a shared entry that is NOT a symlink is a real file/directory
# — typically created by `claude` when it ran before this script (on the mac
# one run after login is enough; in the devbox, an entry that was missing from the shared
# profile during provisioning and the session later created itself). `ln -sfn` onto an existing REAL
# directory does not replace it — it puts a new symlink INSIDE it (`profile/x/x`), silently, with exit 0.
# That is worse than a missing file: it looks like success, but the shared history/settings
# never get linked. Automatically merging the content into the shared profile could IN TURN
# overwrite data belonging to another account — it is safer to fail and let a human decide.
# Accumulator separated by a NEWLINE, not a space — `$profile` may be a path with a space
# (common on the mac, "/Users/name/Library/.../.claude-accounts/primary" etc.) and an unquoted
# `for c in $conflicts` would otherwise split it into several words when printing. Detection and exit
# code are not affected, only the message would get mangled.
conflicts=""
for n in $SHARED_ITEMS; do
  if [ -e "$shared/$n" ] && [ -e "$profile/$n" ] && [ ! -L "$profile/$n" ]; then
    if [ -z "$conflicts" ]; then conflicts="$profile/$n"; else conflicts="$conflicts
$profile/$n"; fi
  fi
done
if [ -n "$conflicts" ]; then
  echo "link-shared-profile: the profile has REAL (not symlinked) content where the link to the shared profile should go:" >&2
  old_ifs="$IFS"; IFS='
'
  for c in $conflicts; do echo "  $c" >&2; done
  IFS="$old_ifs"
  echo "fix it manually (delete/move) and run again — this script never merges anything into the shared profile by itself." >&2
  exit 4
fi

# .claude.json is seeded ONLY on explicit request (4th argument). Without it an existing
# file is LEFT ALONE — on the mac `claude auth login` just created it, and overwriting it with a stripped
# copy of the main profile would erase the identity that login just set.
if [ -n "$seed" ]; then
  if [ -f "$seed" ]; then
    command -v node >/dev/null 2>&1 || { echo "seed .claude.json requires node" >&2; exit 3; }
    # The identity is DISCARDED so Claude fills it in from the actual credentials —
    # otherwise the profile would report an account it has no keys for. Project settings
    # (hasTrustDialogAccepted, allowedTools), on the other hand, are carried over.
    node -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));delete j.oauthAccount;delete j.userID;fs.writeFileSync(process.argv[2],JSON.stringify(j,null,2))' \
      "$seed" "$profile/.claude.json"
  else
    # The source does not exist — in the devbox this is rather the EXCEPTION: tools/agent-sync.ts
    # writes mcpServers into this file (`claude mcp add-json --scope user`),
    # so it almost always exists before the first profile is created. This branch
    # covers only a freshly started devbox BEFORE the first agent-sync (or a deleted
    # claude-home). An empty object is still a valid start — the profile fills in the rest
    # itself, just without MCP servers until agent-sync completes.
    [ -f "$profile/.claude.json" ] || echo '{}' > "$profile/.claude.json"
  fi
fi

for n in $SHARED_ITEMS; do
  # Do not link what is not in the shared profile — a dead symlink is worse than a missing file.
  if [ -e "$shared/$n" ]; then ln -sfn "$target/$n" "$profile/$n"; fi
done
