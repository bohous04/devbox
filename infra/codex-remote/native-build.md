# Native Codex build

`native.patch` applies to the OpenAI Codex tag named in its first line
(`# base: rust-vX.Y.Z`, currently `rust-v0.160.0`). `git apply` ignores that
header; `native-update.py` uses it to fetch the base blobs for a 3-way apply.

The patch adds opt-in devbox routing and lifecycle integration. It preserves
ordinary native behavior unless `DEVD_CODEX_ROUTES_FILE` is configured. The host
daemon and all terminal clients must use a compatible app-server protocol.

Since 0.160 upstream binds the control socket in `/tmp/codex-daemon-<uid>` and
leaves only a symlink in `app-server-control/`. Containers reach the daemon through
the shared `codex-home` volume, so with `DEVD_CODEX_ROUTES_FILE` set the patch keeps
the socket beside the link (`.app-server-control.sock.daemon`, relative symlink).

## Why the daemon must follow upstream releases

The model service gates models by client version. A daemon left on an old
release rejects new models with `400 ... model is not supported when using Codex
with a ChatGPT account`, even though `co` keeps the in-container clients on the
latest npm release (verified on 2026-10-03: `gpt-6.1-sol` failed from 0.153.4 and
worked from 0.160.0 with the same account). Container clients and the daemon
should therefore move together.

## Automatic updates

`codex-native-update.timer` (installed by `infra/setup.sh`) runs
`native-update.py` hourly as root:

1. Compare npm `@openai/codex@latest` with `/opt/codex-devbox/runtime/codex-package.json`.
2. Clone `rust-v<latest>`, apply `native.patch` with `--3way`, build `codex` with the
   `dev-small` profile in `devbox:codex-unified-builder` (`builder.Dockerfile`,
   capped at 20 GB RAM), and run the scoped tests listed below.
3. Stage `/opt/codex-devbox/runtime-<version>` from the official npm platform
   package (integrity-checked; it supplies `codex-code-mode-host`, `rg`, `bwrap`,
   `zsh` and `codex-package.json`) with our build as `bin/codex`; the official
   binary stays beside it as `bin/codex.official`.
4. Between 02:00 and 06:00, and only when `thread/loaded/list` + `thread/read`
   report no `active` thread, atomically repoint the `runtime` symlink, restart
   `codex-remote-control.service`, and require a working RPC session and the new
   `--version` within 90 s. Otherwise it repoints to the previous runtime and
   restarts again. The current and previous runtimes are kept.

Status is in `/var/lib/codex-native-update/status.json`; build and test logs are
next to it. Conflicts, build or test failures, a rollback and a successful update
each send one devd notification. A version whose patch, build or tests failed
(including a build timeout) is not retried until `native.patch` changes;
transient errors such as network failures are retried on the next run.

Manual run: `sudo python3 infra/codex-remote/native-update.py --now` switches
outside the night window (still only when idle); `--build-only` stages without
switching; `--version X.Y.Z` targets a specific release.

## Refreshing the patch after a conflict

```sh
git clone --depth 1 --branch rust-v<new> https://github.com/openai/codex.git src
cd src
git fetch --depth 1 origin tag "$(sed -n 's/^# base: //p' /path/to/native.patch)"
git apply --3way /path/to/native.patch   # resolve the reported files
# build + scoped tests (below), then regenerate:
git add -A codex-rs/app-server codex-rs/core codex-rs/exec-server codex-rs/hooks codex-rs/app-server-transport
{ echo "# base: rust-v<new>"; git diff --cached HEAD --binary; } > /path/to/native.patch
```

Keep `Cargo.lock` and documentation out of the patch: upstream tags ship
`0.0.0` workspace versions in `Cargo.lock`, so the build runs without `--locked`
and cargo rewrites only those internal entries; external dependency versions
and checksums stay as locked upstream.

## Manual build

Build on Linux with the Rust toolchain from the tag's `rust-toolchain.toml`,
clang/libclang, cmake, pkg-config, OpenSSL development headers, protobuf
compiler, Node.js, and Python 3 (`builder.Dockerfile`):

```sh
cd codex-rs
cargo build -p codex-cli --bin codex --profile dev-small
```

`dev-small` reduces build memory and disk use for this private integration.
`/opt/codex-devbox/runtime/bin` needs both `codex` and `codex-code-mode-host`,
with the matching `codex-package.json`, `codex-resources`, and `codex-path`
beside `bin`. The helper is a separate binary; building or copying only `codex`
lets the TUI start but leaves Code Mode tools unavailable. It runs on the central
host and dispatches nested tools into the selected container; it does not need a
bind mount into every container. `native.patch` does not change the Code Mode
host, runtime, or protocol source, so the helper from the exact matching official
release is compatible. Never mix a helper from a different version.

Verify the installed helper with `codex-code-mode-host --help` and the retained
`devd/test/fixtures/codex-code-mode-proof.py` regression, which uses a local
deterministic provider and exercises Code Mode plus a nested tool call. An idle
TUI or healthy app-server alone does not verify that tools can run. Threads that
already initialized while the helper was missing cache that failure and must be
unloaded and resumed after installation. Reopening a CLI can reattach the same
cached runtime. Check that all loaded threads are idle, then restart the central
service and verify TUI reconnection. Previously empty threads may not yet have a
persisted transcript; reopen those as fresh sessions if reconnection reports
that the conversation is unavailable. The service checks that the helper is
executable before future starts.

Required host environment:

- `DEVD_CODEX_ROUTES_FILE`: an atomically written authoritative JSON registry,
  `{"routes":[{"cwd":"/canonical/project","environment_id":"devbox_id","project_id":"native-project-id","thread_ids":[]}]}`.
- `DEVD_CODEX_EXEC_DISPATCH`: an absolute trusted executable. Normal
  `--environment-id ID` attaches only to a running container. Explicit
  `--prepare --environment-id ID` starts it and must finish within 120 seconds.
- `DEVD_CODEX_HOOK_DISPATCH`: the trusted dispatcher used by the native hook
  patch; see the dispatcher implementation for its argv contract.

New IDs are registered lazily without replacing existing executor connections.
Only thread startup and actual turns prepare containers. Listing/status and MCP
prewarming must never start stopped containers. `thread_ids` resolves legacy
`/workspace` history before project config loading without rewriting history.
Native thread metadata presents those legacy paths as their registered canonical
paths. An exact canonical-root list filter uses the route's native `project_id`
when the client supplied no project filter. Explicit project filters, subdirectory
filters, and other list filters retain their native meaning. Starting a thread
at that root without a project ID assigns the registered project immediately.
Unmapped or mismatched project paths fail closed.

Cold resume of a registered devbox also restores the concrete saved permission
profile when no named profile or explicit permission override was selected.
The saved and effective directories must belong to the same registered executor;
explicit daemon CLI permission settings also take precedence. Fork semantics
remain unchanged.
This preserves `co`'s existing YOLO selection across daemon reconnects, and also
preserves explicitly restricted unnamed profiles. Ordinary unregistered Codex
sessions continue to use upstream default-profile resolution. Named profiles,
explicit overrides, and current managed requirements retain their precedence.
Restoration reads both turn contexts and later `thread/settings/update` events;
it does not rewrite historical turns or change global MCP approval settings.

`devd/test/fixtures/codex-permissions-resume-proof.py` verifies this with a real
private app-server restart and nested MCP call against a dedicated Docker route.
`--expect-lost-permissions` reproduces the old loss of YOLO; without it, the saved
profile must survive. The final phase always verifies that an explicit read-only
resume still wins. The loopback model fixture uses no accounts or real models.
`codex-mcp-read-proof.py` separately verifies the reported issue and timer
read operations through an authorized live project's MCP configuration, retaining
only success/error statuses and making no work-item or timer changes.

Scoped checks (the same set `native-update.py` runs before staging):

```sh
cargo test --profile dev-small -p codex-core --lib -- devbox_routes:: environment_selection::
cargo test --profile dev-small -p codex-hooks --lib -- command_runner
cargo test --profile dev-small -p codex-exec-server --test devbox_stdio_reconnect
cargo test --profile dev-small -p codex-app-server --lib -- persisted_resume_settings thread_processor
cargo test --profile dev-small -p codex-app-server --test all -- suite::v2::devbox_routes::
```

Also run the credential-free integration harness against the resulting CLI,
including real container exec, patch, MCP and hook routing, Docker stop/start,
daemon restart, and legacy resume. Local Responses fixtures must handle every
model request during verification.

The retained Linux Docker proof is run from this repository:

```sh
sudo python3 devd/test/fixtures/codex-central-proof.py \
  --base /path/to/isolated-proof \
  --binary /path/to/installed/codex \
  --dispatcher /absolute/path/to/infra/codex-remote/dispatch.py
```

Use an isolated Docker host with the `docker` group. The base directory must be
root-owned and not writable by group or others. Precreate running containers
`dev-codex-unified-a` and `dev-codex-unified-b`, with matching hostnames and user
`dev` (UID 1000). They must be nonprivileged, with their only writable bind mounts
`BASE/workspaces/a` or `BASE/workspaces/b` at `/workspace`. Make those workspaces
writable by `dev` and place `sentinel.txt` containing `CONTAINER_A` or
`CONTAINER_B` respectively. Optional `PROBE_CONTAINER_ENV=container-a` or
`container-b` is checked when configured. Install the native binary together
with its resources.

The harness validates container identities and mounts before writes, creates no
containers, and uses a local Responses fixture with `requires_openai_auth=false`.
It stops only fixture A, verifies listing leaves it stopped and a real turn
restarts it, and leaves both fixtures running on success. It checks exec, MCP,
patches, hooks, dynamic registration, writer exclusion, and paginated history
across a daemon restart. Evidence remains in `BASE/run-*/evidence.json`.
