# Internals

Notes for people working on devbox itself: how the hook integrations work, how to verify
notifications end to end, and what to redeploy after changing a given part.

## What to redeploy after a change

| Changed | Deploy |
|---|---|
| `devd/` | `git pull && systemctl restart devd`, then unlock the vault |
| `dashboard/` | `bun run build:dashboard` (devd serves `dashboard/dist`) |
| `image/` | `docker build -t devbox:latest image/`; running sessions keep the old layer until recreated |
| hook scripts baked into the image (`image/vendor/*-hooks`, `seed-*.sh`) | rebuild **and** copy into running containers (below), or recreate sessions |
| `listener/` | on the Mac: `git pull && bun listener/install.ts`, then `launchctl unload/load` the plist |

Hook configuration (`settings.json`) lives in the shared `claude-home` volume. Running Claude
processes pick it up without a restart. To apply a changed devd hook to running containers
without recreating them:

```bash
R=/opt/vps-dev-infra
for CTR in $(docker ps --format '{{.Names}}' | grep '^dev-'); do
  docker cp "$R/image/vendor/devd-hooks/devd-hook.sh" "$CTR":/opt/devd-hooks/devd-hook.sh
  docker cp "$R/image/seed-devd-hooks.sh" "$CTR":/tmp/seed-devd-hooks.sh
  docker exec "$CTR" bash /tmp/seed-devd-hooks.sh
done
```

Seeders are idempotent and recognize their own entries by the hook path, so they leave
foreign hooks alone.

## Verifying notifications end to end

After deploying devd, the image and the listener:

1. **Blocked:** give an agent a task that makes it ask a question or a permission. Within a
   minute the Mac shows "⏸️ <project>/<repo> — waiting for input" with sound, and
   `sqlite3 /var/lib/devd/devd.sqlite "SELECT type FROM events ORDER BY id DESC LIMIT 3"`
   contains `agent_blocked`.
2. **Click:** clicking the notification focuses the session's Warp tab, or opens a new tab
   running `dev attach <id>`.
3. **Done:** when the turn finishes, "✅ … finished" arrives without sound and the events
   table has `agent_done` with `via: "hook"`.
4. **Idle:** leaving the session idle for minutes must not produce more notifications.
5. **Dashboard start:** "New session" on `/sessions` starts a container (`docker ps`).
6. **Remote control:** the session shows up in the Claude app / claude.ai/code as
   `dev-<project>-<repo>`; a message from the phone arrives in tmux.

## Warp integration

`image/vendor/warp-hooks/warp-hook.sh` and `warp-title.py` send Warp `cli-agent` events
(OSC 777). Codex uses the native `agent: "codex"` and registers start, prompt, blocking
`request_user_input`, tool completion, Stop, Interrupt and SessionEnd. A finished unrelated
tool does not clear a pending question, and a late PostToolUse after Stop does not bring back
"working". A new PreToolUse does bring it back after a reviewer blocked Stop.

Grok has its own hooks in `~/.grok/hooks/warp.json`. Grok ignores `PermissionRequest`, so
waiting is covered by `Notification` with `permission_prompt|elicitation_dialog` and the
PreToolUse `ask_user_question`. A `promptId` stops a cancelled old turn from overwriting a
new one. Grok also imports Claude settings, so the imported copies of the Claude hook stay
silent for Grok's camelCase payload.

Newer Warp builds support Grok natively. On attach, the Mac CLI detects the Warp version and
sets `@devd_warp_grok_native=1|0` on the tmux session. The hook reads it on every event, so
a Warp update takes effect after a reattach. `DEVD_WARP_GROK_NATIVE=1` in the hook
environment is a manual override.

Claude keeps its native stdout `terminalSequence` contract. Only pane ownership and the lock
are shared, so a late Codex/Grok hook cannot overwrite a new Claude session. Codex/Grok write
the sequence straight to the pane tty, wrapped for tmux passthrough (`allow-passthrough on`
is required).

**Conversation titles.** The hook syncs the conversation name on prompt and on finish: Codex
`threads.name` (fallback `title`) from its `state_*.sqlite`, Grok `generated_title` (fallback
`session_summary`) from `summary.json`. Until a name exists, the first prompt (cut to 80
characters) is used. The title goes into the pane option `@devd_auto_title`; a manual
`@devd_label` always wins. No model is called.

Regression tests:

```sh
bun test devd/test/warp-hook.test.ts devd/test/codexHooksSeed.test.ts devd/test/grokHooksSeed.test.ts devd/test/claudeWarpHooksSeed.test.ts
python3 -m unittest discover -s devd/test -p 'warp*test.py'
```

The PTY test runs its own tmux server and checks the real OSC bytes on the outer terminal.
It does not replace checking the rendering in Warp itself.

## Agent auto-updates (`co`, `gr`)

The `co` (Codex) and `gr` (Grok) launchers check for a stable release at most once an hour
per container; `--help` and `--version` skip the check. Check and install together are
limited to 45 s. A network failure or a broken new binary falls back to the installed
version.

The root-owned helper `/usr/local/bin/agent-auto-update` runs via `sudo -n`. It installs the
new version into `/opt/devbox-agent-updates`, verifies it as the `dev` user and switches
`/usr/local/bin/codex` or `/usr/local/bin/grok` atomically, under a lock. Old packages stay
available to running processes. Built-in update prompts of these CLIs are turned off in the
launchers. Manual run: `sudo /usr/local/bin/agent-auto-update codex`.

Tests: `python3 -m unittest discover -s devd/test -p 'agentAutoUpdate_test.py'` and
`bun test devd/test/agentUpdateLaunch.test.ts devd/test/agentLaunch.test.ts`.

## Claude Code upkeep

Once a day inside `settings.ccUpkeep`'s window, devd checks npm for a newer
`@anthropic-ai/claude-code`. If there is one, it rebuilds the image
(`--build-arg CC_VERSION=<version>`; Claude Code has its own layer after Playwright, so
Chromium is not downloaded again) and installs the version into idle containers.

Pane restarts are independent of the install, because something else may upgrade the binary
too (Claude Code's own updater, a manual `npm i -g`). devd measures staleness directly: a
`claude` process that has been running longer than the binary on disk started on an older
version. It gets `/exit` + `cc --resume <conversation id>`, so the conversation continues.

Events: `cc_upgraded` (`installed`, `restarted`, `stuck`), `cc_skipped` (busy session, with
reason), `cc_restart_failed`. Only `cc_upgrade_failed` (build failure) notifies.
