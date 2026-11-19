# Codex shared-home concurrency probe (agent runtime v2, step 3 task 1)

Date: 2026-11-19. Image `devbox:latest` at `62b66bb` (codex-cli 0.169.0).

## Setup

- One test home used as `CODEX_HOME` by two containers at the same time. Its `auth.json` is a symlink to an
  existing Codex account's own `auth.json` in place (the v2 layout: never a copy); everything else in the home was
  created fresh by the probe.
- In each container a `codex app-server` (`cli_auth_credentials_store="file"`) started its own thread and ran 20
  turns back to back ("Reply with exactly: <label>-<n>"), calling `thread/list` after every 5th turn. Both
  containers ran concurrently.
- Afterwards: `PRAGMA integrity_check` on every sqlite file in the home, then a new app-server per thread did
  `thread/resume` and one more turn.

## Result: PASS

| check | result |
|---|---|
| turns completed | A 20/20, B 20/20 |
| `thread/list` during the run | all ok |
| integrity_check (`state_5`, `logs_2`, `memories_1`, `goals_1`, `queue_1`, `thread_history_1`) | ok on all six |
| `thread/resume` of both threads + one turn | 1/1 each |

The sqlite files run in WAL mode, which tolerates several writers on one host.

## Decision

Shared home plus per-account shadow homes (spec "Codex homes"), as planned in step 3 task 2. No transcript copy on
an account switch for v2 sessions.
