# Agent runtime v2, step 1: metering gate (tokens mode)

Date: 2026-11-18. Tool: `tools/metering/compare.ts --mode tokens`, commit `0b07059`, image built from `274d30e`.

## Why tokens mode

The window gate in the step 1 plan reads the account's 5-hour meter. On the day of the measurement
only one pool account reports a 5-hour meter, and its weekly limit was exhausted until 2026-11-23.
The others report only whole-percent weekly limits, far too coarse for a few runs. Tokens mode
compares what each path sends for the same task, taken from the run transcripts (main and subagents).

It cannot see the server billing identical tokens differently per client. That part is still open:
run the window gate on an account with a 5-hour meter once one is available, or compare weekly
percent per token between tmux and chat sessions in normal use.

## Setup

- Task: `tools/metering/task.md` (read a source file and its tests, write an explanation), same repo commit for every run.
- Model `claude-opus-5-5`, one Max account, ABBA order, 5 runs per path, no failed or repeated runs.
- Weighted tokens = input + 1.25 × cache creation + 0.1 × cache read + 5 × output.
- Gate: bridge mean weighted tokens per task ≤ 1.15 × TUI.

## Result: PASS

| path | runs | mean weighted tokens | cache-read share |
|---|---|---|---|
| TUI (`claude` in tmux) | 5 | 128 991 | 0.837 |
| bridge (Agent SDK) | 5 | 106 499 | 0.866 |

Ratio bridge/TUI: **0.826** (limit 1.15). A 1-run dry run gave 0.888.

Per run (weighted tokens): TUI 120 215, 122 091, 124 569, 145 493, 132 588; bridge 83 490, 124 132,
106 175, 121 947, 96 753. The bridge writes less cache (mean 38 k vs 56 k creation tokens) at similar
output, so it does not lose the prompt cache or send a larger prompt than the TUI.

## Decision

Step 2 (Claude and Codex chat, inbox core) may proceed. The server-side billing check above stays
open as a follow-up.
