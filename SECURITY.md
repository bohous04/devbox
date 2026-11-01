# Security

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private vulnerability reporting
(**Security → Report a vulnerability**) on this repository. Include steps to reproduce and
the impact. You should get an answer within a week.

## Threat model

devbox runs autonomous coding agents with broad permissions on a server you own. Read this
before you give it real credentials.

### Who is trusted

- **The operator** (you): anyone on your tailnet, anyone who passes Cloudflare Access to the
  dashboard, and the Mac listener. devd has **no user accounts**. Network position is the
  authentication.
- **Agents are not trusted with secrets, but they are trusted with the workspace.** Sessions
  run Claude Code with `--dangerously-skip-permissions` and the equivalent for Codex/Grok,
  and the `dev` user in the image has passwordless `sudo`. Assume an agent, or a prompt
  injection that reaches it, can do anything inside its container.

### What isolates what

| Boundary | Mechanism | Limits |
|---|---|---|
| internet → devd, dashboard, SMB | ufw: devd `:4300` and the DB proxies only from the tailnet and container ranges; `DOCKER-USER` DROP on `eth0` for published container ports | if your public interface is not `eth0`, adjust the rules ([install.md](docs/install.md#firewall)) |
| session → host | Docker container, non-root user | **without `DEVD_DIND=1` sessions get the host Docker socket, which is root on the host.** Turn on `DEVD_DIND=1` (a Docker-in-Docker sidecar per session) for real isolation |
| session → other sessions | separate containers and worktrees | logins and agent config are **shared volumes** (`claude-home`, `codex-home`, `grok-home`), so any session can read the others' tokens and conversation history. The devd API identifies sessions with a header that a container can set to any value |
| session → secrets | the vault and most secrets stay in devd memory on the host; SSH keys are exposed only as an ssh-agent socket after a human approves (`srv`); prod DB passwords stay in the host proxy | an approved key or grant can be used for anything during its lifetime |
| session → approvals | approve/deny/revoke routes accept only loopback, the tailnet (`100.64.0.0/10`) and `DEVD_APPROVAL_ALLOW` | a container cannot approve its own request, but every operator device on the tailnet can |
| session → production data | read-only roles via a host proxy; writes are separate proposals that a human approves | the read-only role still exposes all data it can read |

### Things to know

- **Containers can call the devd API.** Approval routes are gated by address, but other
  routes (session control, notifications, config reads) are reachable from inside sessions.
  A compromised session can disrupt other sessions.
- **The vault locks on every devd restart.** That protects secrets at rest, but a few files
  must stay in plaintext for unattended jobs (listed in [install.md](docs/install.md#4-secrets-and-the-vault)).
- **`DEVD_SSH_APPROVAL=off`** removes the human from SSH key access. It exists as a
  break-glass only.
- **The Mac listener runs what devd asks it to.** `open` can launch `.command`/`.app` files
  from the workspace, so anything an agent writes there can end up executed on your Mac.
  Keep the listener on the tailnet and the token secret.
- **The account pool** can move sessions between several Claude/Codex subscriptions. That may
  break the providers' terms of service. It is off until you add accounts.
- **Agents install software.** The image pulls agent CLIs, npm packages and Playwright at build
  time. Agents add more at runtime. Pin versions (`CC_VERSION`, `GROK_VERSION`) if you need
  reproducible images.

## Hardening checklist

- [ ] Set `DEVD_DIND=1`, so sessions do not get the host Docker socket.
- [ ] Use the vault (`DEVD_VAULT`) instead of a long-lived `secrets.json`.
- [ ] Close public SSH once Tailscale SSH works, or restrict it to keys + fail2ban.
- [ ] Check from outside that published container ports are closed (`nc -z <public-ip> <port>`).
- [ ] Use Tailscale ACLs to limit which of your devices can reach the devbox.
- [ ] Put Cloudflare Access (or nothing) in front of the dashboard; never expose `:4300` directly.
- [ ] Use dedicated, low-privilege credentials for anything an agent can reach (GitHub
      fine-grained tokens, read-only DB roles, a separate 1Password vault for the broker).
- [ ] Back up `/etc/devd` and keep the borg passphrase off the server.
