# Agent runtime v2, step 3: model, account and harness switching

Date: 2026-11-19. Merged as PR #60 (`1ea8ce6`) and deployed with `devbox-update`. Verified live on the VPS with two
chat sessions on this repo (one started on Claude, one on Codex), driven through the API and the dashboard.

## Scenarios

| # | Scenario | Result |
|---|---|---|
| 1 | Model switch (Claude Opus → Sonnet) | PASS: `set-model`, notice in the thread, the agent answered as Sonnet |
| 2 | Harness Claude → Codex | PASS: `fresh-with-handoff` (5 items); Codex knew the codeword given to Claude |
| 3 | Harness Codex → Claude | PASS: `resume-with-delta` (4 items); the original Claude thread resumed and knew the codeword given to Codex |
| 4 | Account switch (Claude) | PASS: `restart-resume`; an account over its limit was allowed and reported as `exhausted`, the next turn showed the limit; switching to another account resumed the same thread |
| 5 | Proxy profile (`claude-gpt`) | Switch PASS, secret not persisted (`state.json` keeps key names only); the turn failed upstream, see below |
| 6 | Proxy profile refusals | PASS: a profile without a model and a model with an unknown context window were refused before anything was sent |
| 7 | `devbox_thread_read` | PASS from Claude and from Codex |
| 8 | Container restart | PASS: bridge back (v1.1.0), same thread, `check-ready` 0 |
| 9 | devd restart | PASS: both sessions continued |
| 10 | Switch, then container and devd restarted together before the next message | PASS: the pending handoff survived (16 items) and the next turn knew both codewords |
| 11 | Thread that cannot be resumed at bridge start (the step 2 Codex case) | PASS: no crash loop; devd re-planned a fresh thread with the handoff (7 items) and a clear notice |
| 12 | Codex token refresh through the shadow home's `auth.json` symlink | PASS by source and permissions: Codex 0.169 resolves the symlink and atomically replaces the target in the account directory, which is writable by `dev`; the link is kept |
| 13 | Dashboard switchers on the live page, desktop and 390 px | PASS |

## Found during verification

- `claude-gpt` fails upstream with `unknown provider for model gpt-6.1-sol`: `settings.proxyModels.gpt` names a model
  the proxy does not serve (it offers e.g. `gpt-6.1-terra`). Same for tmux sessions; a configuration choice for the
  owner, not a step 3 defect.
- `claude-grok` is refused upstream because the proxy's Grok client version is outdated (426).
- Fixed in the follow-up PR: a Claude result reported as `success` with `is_error` (e.g. a usage limit) showed
  "run ended with success" instead of the limit message; and a model was carried from a proxy profile to a
  subscription account (the switcher showed the proxy's model after switching back to Claude).

## Not verified live

- A full host reboot (covered by the combined container and devd restart).
- Model switches across many turns of a proxy profile (blocked by the upstream model above).

## Follow-ups

DEVBOX-36 (parked review minors). Step 4 continues on `feat/agent-runtime-v2-step4`.
