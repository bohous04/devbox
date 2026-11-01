#!/usr/bin/env bash
# Tests mcp-oom-guard classification against a fake process listing.
set -euo pipefail
cd "$(dirname "$0")"
bash -n mcp-oom-guard.sh && echo "syntax OK"

T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
fail() { echo "FAIL: $*"; exit 1; }
HZ="$(getconf CLK_TCK)"
s() { echo $(( $1 * HZ )); }   # seconds → ticks

# pid ppid starttime comm
cat > "$T/ps" <<PS
10 1 $(s 0) tmux:_server
20 10 $(s 1) zsh
30 20 $(s 2) node
40 30 $(s 3) codex
41 40 $(s 4) serena
42 40 $(s 5) npm_exec_@maso
43 42 $(s 6) node
50 40 $(s 300) serena
51 40 $(s 300) uv
52 51 $(s 301) python
60 40 $(s 400) bash
70 1 $(s 500) node
80 20 $(s 600) claude
81 80 $(s 601) playwright-mcp
PS
MCP_OOM_GUARD_INPUT="$T/ps" bash mcp-oom-guard.sh | sort -n > "$T/out"
adj() { awk -v p="$1" '$1 == p { print $2 }' "$T/out"; }

[ "$(adj 41)" = 500 ] && [ "$(adj 42)" = 500 ] || fail "the main session's MCP set must have 500"
[ "$(adj 43)" = 500 ] || fail "a grandchild of the main MCP set inherits 500"
echo "main set OK"
[ "$(adj 50)" = 1000 ] && [ "$(adj 51)" = 1000 ] && [ "$(adj 52)" = 1000 ] || fail "the subagent set must have 1000"
[ "$(adj 60)" = 1000 ] || fail "a later tool command has 1000"
echo "subagent set OK"
for p in 10 20 30 40 70 80; do
  [ -z "$(adj "$p")" ] || fail "pid $p (agent / ancestor / outside the tree) must not change"
done
[ "$(adj 81)" = 500 ] || fail "MCP under claude gets 500"
echo "untouched OK"
echo "all OK"
