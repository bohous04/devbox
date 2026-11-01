# Stats from the mac

Claude Code on the mac sends metrics to devd through the same OTel pipe as the containers.
The setting is not in git (it is in `~/.claude/settings.json`), hence this runbook —
and hence `dev doctor` checks it.

## Enabling

In `~/.claude/settings.json`, in the `env` block:

```json
"CLAUDE_CODE_ENABLE_TELEMETRY": "1",
"OTEL_METRICS_EXPORTER": "otlp",
"OTEL_EXPORTER_OTLP_PROTOCOL": "http/json",
"OTEL_EXPORTER_OTLP_ENDPOINT": "http://<vps-tailnet-ip>:4300",
"OTEL_METRIC_EXPORT_INTERVAL": "10000",
"OTEL_RESOURCE_ATTRIBUTES": "devbox.host=mac"
```

The endpoint is devd's **tailnet** address — the same as `devdUrl`
in `~/.config/devbox-cli/config.json`. Nothing is opened to the internet.

It applies globally, so all Claude Code work on the mac is counted, not just in one repo.

## Verification

```bash
dev doctor          # the "mac OTel metrics" line must be green
```

Then send a few prompts on the mac, and in the dashboard under **Stats** an
All / Mac / Devbox switch appears.

- **Right after the deploy you will also see an Unknown bucket** — all metrics written
  before this feature have no `devbox.host`, so they fall into it.
- **A running devbox session is relabeled only after a recreate.** The container keeps
  the environment from its start, so a long-running session keeps sending untagged
  rows (Unknown) until you restart/switch it.

## What does not work

- **Outside the tailnet, metrics are lost.** OTel is fire-and-forget; it does not limit the session
  in any way, only the data for that window is missing.
- **Mac rows have no `project`.** `OTEL_RESOURCE_ATTRIBUTES` is global on the mac
  (one block for the whole of Claude Code, not per repo), so no `project` value
  can be sent with it. Mac work therefore does not disappear — it falls into one shared
  bucket: `Unknown` in the Stats project leaderboard, `?` in the leaderboard on Home.
  Because *all* mac work falls into it, it may soon be the largest "project"
  on the page. The account pool shim fills this in
  (see [account-pool.md](account-pool.md)).
- **No backfill** — data exists only from the moment it was enabled.
