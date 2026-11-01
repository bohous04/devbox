# One Codex Remote for the whole devbox

The app uses a single persistent Codex app-server on the host. Containers are its
compute environment. Pairing and the shared history live in the `codex-home` volume;
stopping a container does not change the Remote registration nor remove the project from the catalog.

`co` connects to the same server as the app via a shared Unix socket.
A project has an unambiguous path corresponding to the host bind mount `/workspace`.
By that path the server routes commands, file work, stdio MCP and command hooks to the
correct container. Native writer locks protect conversations still used by the
original standalone CLI; such a conversation can be taken over after its process ends.

## Operation

- `codex-remote-control.service`: the persistent host server, UID/GID 1000,
  the shared CODEX_HOME attached via systemd `BindPaths`. A locked service account
  and group with UID/GID 1000 must exist on the host; the directory `/home/dev`
  must be writable for this account.
- `codex-devbox-catalog.service`: fills in projects and history assignments.
  It also keeps stopped and removed containers.
- `/etc/codex-devbox/routes.json`: the authoritative host registry;
  the public copy `devbox-routes.json` in the shared home serves the `co` launcher.
- `/opt/codex-devbox/dispatch.py`: verifies the Docker name and the actual source of
  `/workspace`; only explicit preparation of a conversation may start a container.
  It then confirms the running state via devd, so the dashboard and session management stay
  in sync. The authoritative registry has `devd_url: "http://127.0.0.1:4300"`.

Browsing the list, history and MCP state does not start containers. Continuing a
conversation asks devd via `POST /api/sessions/:id/resume-remote` for the original
environment. A stopped container is started; a removed one is recreated under the same
ID and with the same working directory. This holds even after the session row is removed
from the VPSbetter database. Then the canonical bind mount is restored and the path verified.

The catalog also keeps recovery data in the trusted registry: folder,
project, repo, working directory, bare repo and the current Git branch. When ending
a session with recorded Remote history, devd preserves its worktree, including
uncommitted files. The container and DinD may still be removed. For a worktree
removed earlier, the preserved verified Git branch is used; this procedure cannot bring back uncommitted files
from a directory deleted earlier. Recovery does not pull or
rebase and does not send the model an initial task.

Unassigned history stays visible. A missing or ambiguous recovery source
is rejected; history is not redirected to another project nor to an empty directory.

Inside the devbox, use `co`, `co resume` or `co resume UUID`. `co --help`,
`co --version`, login and non-interactive CLI commands keep the original path.
An explicit `--remote` respects the chosen endpoint. `DEVD_CODEX_REMOTE=0` is
a manual escape to the standalone CLI for diagnostics. New container pairing is not
part of normal use.

## Native modification

This setup uses a pinned modification of Codex 0.153.4; the stock app-server
does not preserve the required project routing across a restart. The source patch and the build
procedure are in [native-build.md](../infra/codex-remote/native-build.md).
Do not overwrite the host binary with the automatic upstream updater.
When updating, verify compatibility with the container CLI and the integration test.

Hooks run with the container environment and the variables passed by the native hook runtime (for example the plugin root). Trust
in configured command hooks matches the previous `co` with bypass hook trust;
individual current hashes are carried over, other entries are preserved.
The direct TUI shortcut `!command` is not routed yet and ends with an error; regular
conversation tools use the correct container environment.

## Migration from the old host

Keep a backup of the service unit, the original binary, both CODEX_HOMEs and identities.
`tools/codex-central-state.py install-host-identity` checks the account and prepares
the takeover of exactly the original registration. Use `--apply` only with both the old and
the new host server stopped. The tool does not change conversation bytes nor copy foreign accounts.

The temporary private home from the previous setup can be restored only after its
writer is stopped and `verify-rejoin` succeeds. The check locks both histories and compares
the rollouts and the five relevant databases; it refuses to overwrite a differing history.
The original files are kept for rollback.

After the switch, verify the Remote status, projects, paginated history, the shared socket
from containers and continuation after Docker stop/start and a restart of the host service.
The server state alone does not prove that the list has already been restored in the app.

For this, devd provides `POST /api/sessions/:id/externally-started`. The endpoint
does not start processes nor change working files; it verifies an actually running container
and only on a transition from the stopped state restores its state and activity.
The production variant keeps the existing session lock and resets `auto_end`.

Automatic recovery is in `infra/codex-remote/restoreSession.ts`.
The catalog reads `/var/lib/devd/devd.sqlite` and `/srv/dev`; other locations are set by
`--devd-db` and `--devd-root`. On an error in the recovery metadata it keeps the original data
and blocks their use via `restore_error` until they are re-verified.

Regressions: the Python dispatcher/catalog, Bun `remoteRestore.test.ts` and a real
Docker cycle in `devd/test/fixtures/codex-restore-proof.ts`. The last one uses
an isolated copy of the production sources and a temporary Git/SQLite; it does not read accounts nor send
model requests. It verifies recovery after `stop` and `end`, the same ID and a preserved HEAD,
index, modified and untracked files.
