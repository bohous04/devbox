#!/usr/bin/env bash
# Manual E2E against a real InstaBox: creates a session, verifies the VM → devd path, attach,
# desktop link and pause/resume, then deletes the session. Usage:
#   DEVD_API=http://<vps-tailnet-ip>:4300 infra/instabox/smoke.sh <folder> <project> <repo>
set -euo pipefail
F=$1 P=$2 R=$3
API=${DEVD_API:?set DEVD_API=http://<VPS tailscale IP>:4300}
SSH=${DEVBOX_SSH:-devbox}
j() { curl -fsS "$@"; }
py() { python3 -c "$1"; }

# ID is set only when create returned a session that (probably) still exists.
# ENDED=1 is set only by a successful step 6 — the trap then does not end again what the script itself
# already ended correctly. If anything fails BETWEEN 1) and 6), the machine and session would otherwise stay
# hanging on the real InstaBox account (and they are billed while running).
ID=""
ENDED=0
# Ending a session: a create that is still running holds the session lock → devd returns 409 on /end.
# Then we wait (create finishes or falls into rollback) and retry; 404 = the session no longer
# exists (rollback deleted it), which counts as cleanup too.
end_session() {
  local code
  for _ in $(seq 1 120); do
    code=$(curl -sS -o /dev/null -w '%{http_code}' -XPOST "$API/api/sessions/$1/end" -H 'content-type: application/json' -d '{}' 2>/dev/null || echo 000)
    case "$code" in
      204|404) return 0 ;;
      409) sleep 5 ;;
      *) return 1 ;;
    esac
  done
  return 1
}
cleanup() {
  local rc=$?
  if [ -n "$ID" ] && [ "$ENDED" -eq 0 ]; then
    echo "cleanup: run failed/interrupted — ending leftover session $ID" >&2
    end_session "$ID" \
      && echo "cleanup: ended $ID" >&2 \
      || echo "cleanup: end call for $ID failed too — check dashboard/InstaBox panel manually" >&2
  fi
  exit "$rc"
}
trap cleanup EXIT

CLONE=$(j "$API/api/tree" | py "import sys,json;t=json.load(sys.stdin);print([r['cloneUrl'] for p in t if p['folder']=='$F' and p['project']=='$P' for r in p['repos'] if r['name']=='$R'][0])")
echo "1) create"
RESP=$(j -XPOST "$API/api/sessions" -H 'content-type: application/json' \
  -d "{\"folder\":\"$F\",\"project\":\"$P\",\"repo\":\"$R\",\"cloneUrl\":\"$CLONE\",\"host\":\"instabox\"}")
JOB=$(echo "$RESP" | py 'import sys,json;print(json.load(sys.stdin)["jobId"])')
ID=$(echo "$RESP" | py 'import sys,json;print(json.load(sys.stdin)["sessionId"])')
S=""
for _ in $(seq 1 300); do S=$(j "$API/api/instabox/jobs/$JOB"); echo "$S" | grep -q '"status":"running"' || break; sleep 2; done
if echo "$S" | grep -q '"status":"error"'; then
  echo "FAIL create: $S"
  # devd rolls back by itself on error (deletes the session and the machine) — there is nothing to end,
  # and calling /end would just needlessly report 404.
  ID=""
  exit 1
fi
if ! echo "$S" | grep -q '"status":"done"'; then
  # Create is still running (wait timed out): ID stays, the trap ends the session once create releases it.
  echo "FAIL create: still running after timeout: $S"
  exit 1
fi
HOST=$(j "$API/api/sessions" | py "import sys,json;print([s['dockerHost'] for s in json.load(sys.stdin) if s['id']=='$ID'][0])")
dx() { ssh "$SSH" "docker -H ssh://$HOST exec $ID $*"; }
echo "2) VM → devd over Tailscale (hooks and OTel path)"
dx sh -c "'curl -sf -m 5 \"\$DEVD_URL/api/health\"'" >/dev/null || { echo "FAIL: container cannot reach devd"; exit 1; }
echo "3) attach (non-interactive: tmux main exists)"
dx tmux has-session -t main
echo "4) desktop link"
URL=$(j -XPOST "$API/api/sessions/$ID/desktop-link" -H 'content-type: application/json' -d '{}' | py 'import sys,json;print(json.load(sys.stdin)["url"])')
curl -fsS -o /dev/null "$URL"
echo "5) pause/resume, tmux survived"
j -XPOST "$API/api/sessions/$ID/stop" >/dev/null
# Reopening EXACTLY this InstaBox session (sessionId) — without it open could pick
# a different (e.g. running VPS) session of the same repo.
OPENED=$(j -XPOST "$API/api/sessions" -H 'content-type: application/json' -d "{\"folder\":\"$F\",\"project\":\"$P\",\"repo\":\"$R\",\"sessionId\":\"$ID\"}" \
  | py 'import sys,json;s=json.load(sys.stdin)["session"];print(s["id"], s.get("host"))')
[ "$OPENED" = "$ID instabox" ] || { echo "FAIL reopen: got '$OPENED', expected '$ID instabox'"; exit 1; }
HOST=$(j "$API/api/sessions" | py "import sys,json;print([s['dockerHost'] for s in json.load(sys.stdin) if s['id']=='$ID'][0])")
dx tmux has-session -t main
echo "6) end"
j -XPOST "$API/api/sessions/$ID/end" -H 'content-type: application/json' -d '{}' >/dev/null
ENDED=1
echo OK
