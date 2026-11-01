#!/usr/bin/env bash
# image/test-mac-sync.sh — the script's contract, without touching a real mac.
set -euo pipefail
cd "$(dirname "$0")"
fail=0
check() { if eval "$2"; then echo "ok:   $1"; else echo "FAIL: $1"; fail=1; fi; }

# srv writes its own messages to stdout; as an rsync -e transport it would break the protocol.
check "mac-sync does not use srv as the rsync transport" \
  '! grep -qE "\-e[[:space:]]+[\"'\'']?srv" mac-sync'
check "mac-sync activates the key via srv with the required --why" \
  'grep -q "/usr/local/bin/srv" mac-sync && grep -q -- "--why" mac-sync'
# The script defines $SOCK once and then only exports it — the literal
# "SSH_AUTH_SOCK=/run/devd/ssh-agent.sock" therefore never appears in the file.
# We check both halves: the constant's definition and its actual use.
check "mac-sync uses the agent socket from the host" \
  "grep -qF 'SOCK=\"/run/devd/ssh-agent.sock\"' mac-sync && grep -qF 'SSH_AUTH_SOCK=\"\$SOCK\"' mac-sync"
# Same for known_hosts: the KNOWN_HOSTS constant is defined once and
# used via the variable in TWO places (srv activation and the SSH variable for
# rsync/xcodegen) — a pin removed from only one of them would pass the old test,
# because grep -q is satisfied with a single occurrence.
check "mac-sync pins known_hosts in both places (srv and the SSH variable)" \
  "grep -qF 'KNOWN_HOSTS=\"/opt/mac-mcp/xcode/known_hosts\"' mac-sync && [ \"\$(grep -cF 'UserKnownHostsFile=\$KNOWN_HOSTS' mac-sync)\" -ge 2 ]"
check "mac-sync enforces StrictHostKeyChecking=yes and never accept-new" \
  'grep -qF "StrictHostKeyChecking=yes" mac-sync && ! grep -q "accept-new" mac-sync'
check "mac-sync excludes node_modules and DerivedData" \
  'grep -q -- "--exclude=node_modules" mac-sync && grep -q -- "--exclude=DerivedData" mac-sync'
# A mere occurrence of the variable name would pass even if the guard (exit 1 on a missing
# DEVD_SESSION_ID) were deleted — SESSION="${DEVD_SESSION_ID:-}" would satisfy the test
# anyway. We bind to the guard's own error message (unique to that line,
# unlike the generic "DEVD_SESSION_ID", which also appears in the whitelist
# guard below and would thus mask its deletion).
check "mac-sync without DEVD_SESSION_ID exits with an error (the guard, not just the name)" \
  'grep -qE "DEVD_SESSION_ID missing.*exit 1" mac-sync'
# mac-sync runs as root in /usr/local/bin, reachable from the agent's shell —
# so the caller is not only the bridge preflight. DEVD_SESSION_ID and IOS_DIR go into
# the remote command and the --delete target, so both must be validated
# against a character whitelist, not just checked for being non-empty.
check "mac-sync rejects DEVD_SESSION_ID outside the safe character whitelist" \
  'grep -qE "suspicious DEVD_SESSION_ID.*exit 1" mac-sync'
# "!= *..*" is unique to the guard itself (the IOS_DIR comment above does not use
# this literal), so deleting just the traversal clause really gets caught.
check "mac-sync rejects IOS_DIR outside the safe whitelist and with .. traversal" \
  'grep -qE "suspicious subdirectory.*exit 1" mac-sync && grep -qF "!= *..*" mac-sync'
# registration.json owns the target — mac-sync used to hard-code it, so the offline
# drill (Task 9 Step 5 of the plan, pointing the registration at a nonexistent IP) only tested
# the upstream connect and the preflight still rsynced to the real mini. The second argument
# is required: a specific mac's default address does not belong in the repo and the preflight always sends the target.
check "mac-sync takes the target as a required second argument" \
  "grep -qF 'TARGET=\"\${2:-}\"' mac-sync"
check "mac-sync without a target exits with an error before touching the network" \
  'out="$(DEVD_SESSION_ID=test-session ./mac-sync ios 2>&1)"; rc=$?
   [ "$rc" -ne 0 ] && echo "$out" | grep -q "missing target" && ! echo "$out" | grep -qE "srv:|ssh:|rsync:"'
check "mac-sync validates the target with the same whitelist as registration.py (TARGET_RE)" \
  'grep -qE "suspicious target.*exit 1" mac-sync'
# The key title comes from the registration (the runner changes: mini → MacBook "iOS builder") —
# hard-coded, it would ask for a key the new mac does not know after a mac swap.
check "mac-sync takes the 1P key title as an optional third argument" \
  "grep -qF 'KEY_TITLE=\"\${3:-SSH Key - Mac mini}\"' mac-sync && grep -qF 'srv \"\$KEY_TITLE\"' mac-sync"
check "mac-sync rejects a key title that looks like an option" \
  'out="$(DEVD_SESSION_ID=test-session ./mac-sync ios ai@1.2.3.4 "-oProxyCommand=x" 2>&1)"; rc=$?
   [ "$rc" -ne 0 ] && echo "$out" | grep -q "suspicious key title" && ! echo "$out" | grep -qE "srv:|ssh:|rsync:"'

# Dynamic test: mac-sync must reject a malformed target BEFORE it touches the network
# (no srv/ssh/rsync call) — otherwise the preflight would needlessly wait for key approval
# for a target that will never pass anyway. out/rc are kept inside the eval'd statement so
# they do not remain as "unused" variables in the main script.
check "mac-sync rejects a malformed target before touching the network" \
  'out="$(DEVD_SESSION_ID=test-session ./mac-sync ios "evil host" 2>&1)"; rc=$?
   [ "$rc" -ne 0 ] && echo "$out" | grep -q "suspicious target" && ! echo "$out" | grep -qE "srv:|ssh:|rsync:"'
# A repo that has no iOS project yet (ios/project.yml) must not block the preflight.
# Otherwise not even tools that do not need the project at all (list_sims,
# doctor, boot_sim) could be called, and the agent could not verify Xcode before writing the first line of Swift.
# So xcodegen runs only behind a project.yml guard and is otherwise skipped
# with a warning — the sync itself always happens.
check "mac-sync runs xcodegen only when project.yml exists" \
  'grep -E "xcodegen generate" mac-sync | grep -qF "project.yml"'
check "mac-sync without project.yml skips xcodegen with a warning, does not fail" \
  'grep -qF "xcodegen skipped" mac-sync && ! grep -E "xcodegen skipped" mac-sync | grep -q "exit"'
exit $fail
