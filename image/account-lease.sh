#!/usr/bin/env bash
# account-lease — prints CLAUDE_CONFIG_DIR for this session, or NOTHING.
#
# Fail-open is a requirement: this script sits in the startup path of EVERY Claude session
# in the container. When devd does not answer, it stays silent and agent-launch then runs on the shared
# claude-home exactly as before. It never returns a non-zero code.
set -u
: "${DEVD_URL:=}"
: "${DEVD_SESSION_ID:=}"
: "${ACCOUNT_PROFILE_ROOT:=/home/dev/.claude-accounts}"

[ -n "$DEVD_URL" ] && [ -n "$DEVD_SESSION_ID" ] || exit 0

# `/home/dev/.claude-accounts` is NOT CREATED in the image — it exists only when
# at least one account profile is mounted. Without this check EVERY start of a
# Claude session in a container without a single account (today's production state) would ask
# devd needlessly: devd would create a lease for it (the account looks busy even though this
# session never uses it — that inflates the poller cadence and the dashboard), and with a
# dead devd it would add up to 2 s to startup that today (without the pool) does not exist.
[ -d "$ACCOUNT_PROFILE_ROOT" ] || exit 0

# Hard timeout per attempt: session start must not wait on the network. There are several
# attempts, though, because devd has a single thread and calls docker, git and op via Bun.spawnSync
# (docker.ts → git.ts `sh`, op.ts): recreating a NEIGHBORING container blocks its
# whole event loop for seconds. The lease of a session that is just starting then hangs in the queue,
# a single 2 s attempt gave up, and on 2026-09-03 a session was born on the shared
# profile — devd recorded its lease as soon as it unblocked, in exactly the second
# it finished recreating the other one (+4 s, verified in the DB). A dead devd
# (connection refused) fails immediately, so retries add only the pauses; a stuck devd
# costs at most tries × timeout + pauses.
: "${ACCOUNT_LEASE_TIMEOUT:=2}"
: "${ACCOUNT_LEASE_TRIES:=3}"
: "${ACCOUNT_LEASE_PAUSE:=1}"
try=0
while :; do
  try=$((try + 1))
  lease=$(curl -fsS --max-time "$ACCOUNT_LEASE_TIMEOUT" -G \
    --data-urlencode "client=devbox" \
    --data-urlencode "session=$DEVD_SESSION_ID" \
    --data-urlencode "label=${DEVD_PROJECT:-}/${DEVD_REPO:-}" \
    "$DEVD_URL/api/accounts/lease" 2>/dev/null) && break
  [ "$try" -ge "$ACCOUNT_LEASE_TRIES" ] && exit 0
  sleep "$ACCOUNT_LEASE_PAUSE"
done

acct=$(printf '%s' "$lease" | jq -r '.accountId // empty' 2>/dev/null) || exit 0
[ -n "$acct" ] || exit 0

# The profile must really be mounted in the container. An old container (created before
# the account was added) has no mount — setting CLAUDE_CONFIG_DIR to a nonexistent path would
# mean a logged-out agent, which is worse than the shared profile.
[ -d "$ACCOUNT_PROFILE_ROOT/$acct" ] || exit 0
printf '%s\n' "$ACCOUNT_PROFILE_ROOT/$acct"
