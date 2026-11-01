# Anthropic account pool — what is left unfinished

State as of 2026-07-29. The feature is on `main` (`a60fcc5`) and devd is deployed, but **the accounts are not
set up and the image has not been rebuilt** — without that the pool does nothing and behaves exactly as before.

The list came out of triaging findings from the per-task review and the final whole-branch review. Items
marked ⚑ have a real impact; the rest is cosmetic, which the final review assessed as
"leave it be".

## Required before the pool is enabled

1. **Rebuild the image.** `image/agent-launch.sh`, `account-lease.sh` and `link-shared-profile.sh`
   are new. Without a rebuild, containers do not call the pool (they have the old launcher) and `provisionProfile`
   fails on the missing `/usr/local/bin/link-shared-profile`.

## ⚑ Follow-ups with real impact

- **The pane is not read by its actual profile.** `restartPanes` restarts *all* claude panes
  in the container, including those already on the target account — so even a correct `dev switch` kills
  the turn of a healthy neighbour. Same cause: a split session whose **both** leases are older than
  `leaseMaxAgeMs` can mask a needed switch. Both are solved by reading the pane's actual
  `CLAUDE_CONFIG_DIR` (e.g. from `/proc/<pid>/environ`).
- **MCP servers registered after the profile was provisioned do not get into it.** `.claude.json` is
  intentionally per profile and `agent-sync` writes only into `claude-home`. A session on such a profile then
  silently lacks the new server.

## Minor items

- `dead: true` in `accountTokens.ts` covers all 4xx except 408/429 — the rest is fine,
  but a 4xx for other reasons (e.g. a 403 during a temporary ban) would still lead to quarantine.
- `setErr(null)` on the Settings page runs on every poll, so within 60 s it can clear the error
  from a failed account addition before you manage to read it.
- `fetchedAt` is not shown in the UI; the age of the data is visible only indirectly via `error`.
- Devbox sessions do not add `devbox.account` to `OTEL_RESOURCE_ATTRIBUTES` (the mac shim does),
  so the per-account statistics breakdown works only for the mac so far.

## What was deliberately NOT done

- **The mac shim is not installed.** It sits in front of every `claude` launch, so it is enabled only deliberately.
- **Automatic switching of a running session.** It stays manual via `dev switch`, because a restart
  in the middle of a turn destroys that turn.
