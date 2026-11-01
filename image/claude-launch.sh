#!/usr/bin/env bash
# Backward-compatible shim. Containers running from older images have this path
# baked into the entrypoint and into the attach commands the CLI sends them — the logic lives
# in agent-launch, only the redirect to Claude remains here.
exec /usr/local/bin/agent-launch claude "$@"
