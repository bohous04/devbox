# infra

Server-side setup and systemd units. Start with [docs/install.md](../docs/install.md).

| File | Purpose |
|---|---|
| `bootstrap.sh` | clone the repo to `/opt/vps-dev-infra` and run `setup.sh` |
| `setup.sh` | idempotent host setup; optional parts via `DEVBOX_FEATURES` |
| `devd.service`, `devd.env.example` | devd unit and the optional install-specific environment |
| `hardware.example.json` | machine registry template for the Hardware tab |
| `docker-user-firewall.*` | DROP new connections from `eth0` to published container ports |
| `devbox-backup.*` | nightly borg backup (installed by hand, see docs) |
| `devd-watch.*` | external watchdog: devd alive, vault unlocked, heartbeat |
| `cliproxy.service`, `cliproxy-config.example.yaml` | local proxy for proxy profiles (`cliproxy` feature) |
| `codex-plugin-keeper.*` | repairs the shared Codex plugin cache after updates |
| `codex-remote/` | custom Codex app-server build and remote-session tooling |
| `cc-host` | `cc` on the host: throwaway Claude Code container |
| `devbox-paste`, `hammerspoon-devbox.lua` | Mac clipboard paste helpers |
| `rehearsal.sh` | rebuild rehearsal in a container or a throwaway VM |
| `test-setup.sh` | tests for `setup.sh` |
