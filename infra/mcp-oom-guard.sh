#!/usr/bin/env bash
# mcp-oom-guard — when a session container runs out of memory, make the OOM killer kill child
# processes, not the main agent.
#
# Codex starts its own copy of all MCP servers for every subagent (~1 GB per set). A team
# of agents thus fills the container limit (12 GiB) and the memcg OOM killer then takes the process with
# the highest score — the main `codex` (largest RSS) → the whole session dies.
#
# So the keeper raises oom_score_adj for every descendant of the agent (codex/claude):
#   500  — children started within GRACE s of the agent start = the main session's MCP set,
#   1000 — everything later = subagent MCP sets and tool commands.
# The agent itself stays at 0, so on OOM the subagent MCPs die first, then the main session's
# MCPs, and the agent only at the very end. A killed MCP = a broken tool, not a dead session.
# Runs from a timer on the HOST (root), via /proc — needs nothing in the container.
set -euo pipefail

CGROOT="${MCP_OOM_GUARD_CGROOT:-/sys/fs/cgroup/system.slice}"
GRACE="${MCP_OOM_GUARD_GRACE:-60}"   # seconds since agent start during which it is still its own MCP set
HZ="$(getconf CLK_TCK)"

# stdin: "pid ppid starttime comm" → stdout: "pid adj" for every descendant of the agent.
classify() {
  awk -v grace="$((GRACE * HZ))" '
    { ppid[$1] = $2; start[$1] = $3; comm[$1] = $4 }
    END {
      for (p in ppid) {
        child = p; a = ppid[p]
        # nearest ancestor that is an agent; `child` = its direct child on the path to p
        while (a in ppid && comm[a] != "codex" && comm[a] != "claude") { child = a; a = ppid[a] }
        if (!(a in ppid)) continue
        print p, (start[child] - start[a] <= grace ? 500 : 1000)
      }
    }'
}

# Host PIDs of all processes in session containers (dev-*, not dind-*).
list_procs() {
  local id
  for id in $(docker ps -q --no-trunc --filter name='^dev-'); do
    find "$CGROOT/docker-$id.scope" -name cgroup.procs -exec cat {} + 2>/dev/null
  done | while read -r pid; do
    # /proc/<pid>/stat: "pid (comm) state ppid … starttime(22)"; comm may contain spaces
    read -r stat 2>/dev/null < "/proc/$pid/stat" || continue   # builtin — no fork per process
    comm="${stat#*(}"; comm="${comm%)*}"
    set -- ${stat##*) }
    echo "$pid $2 ${20} ${comm// /_}"
  done
}

[ -n "${MCP_OOM_GUARD_INPUT:-}" ] && { classify < "$MCP_OOM_GUARD_INPUT"; exit 0; }

list_procs | classify | while read -r pid adj; do
  f="/proc/$pid/oom_score_adj"
  read -r cur 2>/dev/null < "$f" || continue   # process has exited in the meantime
  [ "$cur" = "$adj" ] && continue
  echo "$adj" > "$f" 2>/dev/null || true   # process has exited in the meantime
done
