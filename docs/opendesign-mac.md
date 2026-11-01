# OpenDesign on the Mac from every devbox session

The shared MCP entry is `open-design`. Its executable, Mac registration and
verified SSH host key live in the `codex-home` volume under
`/home/dev/.codex/integrations/open-design/`. Every work container mounts that
volume, including new sessions. Account-specific Codex/Claude configuration is
updated as well; newly created accounts inherit the shared configuration.

The bridge serves initialization, tool/resource discovery and pings from a local
`catalog.json`. These operations never start SSH or request a key, including when
the Mac is unavailable. The catalog contains descriptions and schemas, not tool
results or project contents. It is captured from the installed Mac application.

The first actual tool call or resource read starts `ssh_transport.py`, which
calls the existing `srv` SSH broker using the current `DEVD_SESSION_ID`. Further
calls reuse that connection. The broker keeps private keys on the host and
retains its normal per-session approval flow. `known_hosts` pins the Mac's
verified Ed25519 key. Actual app operations require a reachable Mac over Tailscale
and an unlocked devd credential vault. Connection failures are reported to the
caller; submitted operations are never automatically replayed.

The Mac launcher discovers the installed OpenDesign runtime through its SDK,
reuses its current daemon, or launches the installed app in headless mode. It
does not store an ephemeral HTTP port or publish the daemon to the network.
The reference launcher is `tools/opendesign/launch-mcp.mjs`; the registration
points at the installed copy on the Mac.

## Installation

Copy `tools/opendesign/` to the devbox host. Supply the already working Mac
registration JSON (`target`, absolute `command`, `args`, optional `env`) and a
known_hosts line containing the exact target host and an independently verified
Ed25519 public host key. Capture discovery metadata locally on the Mac using the
working registration (no SSH or tools are invoked):

```sh
python3 tools/opendesign/capture_catalog.py \
  --registration /private/staging/registration.json \
  --output /private/staging/catalog.json
```

Copy that catalog to private staging on the devbox. Run the installer with Python
3.11 or later (the runtime bridge also requires Python 3.11+):

```sh
python3 tools/opendesign/install.py \
  --registration /private/staging/registration.json \
  --known-hosts /private/staging/known_hosts \
  --catalog /private/staging/catalog.json
```

The installer updates only OpenDesign in the shared Codex, Claude and Grok
configuration and existing account profiles. It preserves other settings and
credentials, backs up changed files under `/var/backups/devbox-open-design/`,
and is idempotent. The manifest records the original location of each backup.
No container recreation or devd restart is required. Later installer runs reuse
the installed catalog unless `--catalog` is supplied. After an OpenDesign app or
plugin update changes its tool/resource catalog, capture and install it again;
this maintenance step is intentionally separate from session startup.

Host-specific provisioning is recorded separately in `/etc/devd/mcp-local.json`
(`DEVD_MCP_LOCAL` can override the location). `tools/agent-sync.ts` merges this
overlay after its normal MCP source, so vault hydration and catalog pruning
preserve OpenDesign. Stdio provisioning retains environment forwarding and
startup/tool timeouts. Do not place the registration only in
`agent-secrets.json`: devd regenerates that file from the vault.

Discovery has a 10-second startup timeout. The first tool call has up to 300
seconds to cover the SSH approval, Mac startup and operation; the bridge limits
connection setup to 150 seconds and the remote operation to 120 seconds.

Codex forwards `DEVD_SESSION_ID` and `DEVD_URL`; the bridge must run in the
selected devbox executor. The shared path is also visible to centralized Codex
Remote, whose existing executor routing starts the MCP inside the container.
It is not a standalone host MCP registration.

## Verification and use

Run the affected installer tests with Python 3.11+ and provisioning tests with Bun:

```sh
python3 -m unittest devd/test/opendesignLazyBridge_test.py devd/test/opendesignInstall_test.py
bun test devd/test/claudeSetup.test.ts
```

Check that initialization, discovery and pings add no SSH approvals or
`ssh_key_access` events in devd. Then make a `list_projects` call from the same
bridge: only this call should invoke the broker, and a second call must reuse
the connection. Native Claude/Grok connectivity checks now validate local
discovery only; an actual tool call is needed to prove the Mac connection.
These checks do not start design generation or spend credits.

The proxy follows the MCP [initialization lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle)
and [cancellation rules](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/cancellation),
including forwarding request IDs in both directions and discarding late results
after cancellation.

Already running agent processes may need an MCP reconnect or restart/resume to
load changed configuration. Keep their conversation history and containers.
When multiple sessions use the same Mac application, specify the intended
OpenDesign project explicitly; omitted project arguments use the active project
in the Mac app.
