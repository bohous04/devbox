# Release of the production DB onboarding fix — 10 September 2026

The user authorized the commit and deploy of the devbox. The fix is deployed on the host
`devbox`, service `devd`, dashboard `http://<vps-tailnet-ip>:4300`.
Neither `acme-billing` nor its already completed production migration was run by this release.

## Revisions and scope

- `01b15fb`: onboarding, Operations, host executor, live catalog/CLI, separate
  SQL approval and follow-up deploy, Coolify parser and POST shim, instructions and tests.
- `ae1615c`: portability of the real OpenSSH test to Linux.
- `8c56aa1`: readable application name and scoping discovery errors to the selected DB;
  own and shared blocks remain visible.
- Connector in the separate repository `coolify-mcp-deploy-post`:
  `1fdabf023196d6171e1d5ca47f81f98bc35b362b`. The source backport is committed;
  it is neither globally installed nor published. The devbox uses its own targeted shim.

The final runtime revision is **`8c56aa1eb797839af15f79f91e34ce3a700d26f0`**,
deployed at **10:24:06 Europe/Prague**. The first release happened at 10:08:56. The image
`devbox:prod-db-ae1615c` and `devbox:latest` has the ID
`sha256:3131ec8983e8463df7730075438dad74bc56bc44edb63e412bf2f88dbe08e210`.
It is built as a layer on top of the original immutable image, changing only `prod-db`,
`db-request`, the guide and the Coolify shim. It keeps the original agent versions and other tooling.

Before the release, the local commit, the actual production sources and the running image were compared.
The existing uncommitted production changes for Codex accounts and Remote restore were
preserved. Four overlapping files were merged in an isolated staging directory;
source fingerprints were re-verified before the switch. The original local checkout was not changed.
After verification, the production Git HEAD moved to `8c56aa1`; unrelated in-progress
changes stayed in the working tree and the index stayed empty. The commits were transferred
directly using a Git bundle. No push to GitHub was made.

## Verification

- Base implementation: **2 184 passed, 34 skipped, 0 failed**, 6 069 assertions.
  The scope and limits of the integration tests are described in the [technical record](prod-db-onboarding.md).
- The pre-release security check added a ban on redirects in the Coolify shim,
  atomic identification of the managed SSH account and an early check of host
  tools. The follow-up targeted suites passed.
- Actual merged Linux release: **234 passed, 0 failed**, 890 assertions,
  21 files. Synthetic PostgreSQL 17 and real OpenSSH verified grants, DDL,
  the proxy, rejection of a shell/reverse tunnel/other target and workflow continuation.
  1Password and Coolify transports in the full scenario were simulated.
  The test cluster was removed after verification.
- The merged runtime TypeScript sources, dashboard TypeScript and build passed.
  The full TypeScript/test run of the neighbouring production Remote restore has a fixture error
  that already existed before the release: `removeStopped` is missing in `RestoreOperations`
  (`devd/test/remoteRestore.test.ts:29`). The same error was reproduced on the
  original production base; this unrelated fixture was not changed.
- Additional form fix: **55 passed, 0 failed**, 207 assertions,
  locally and on the merged Linux release; TypeScript and the dashboard build passed.
  The updated Playwright scenario passed in an isolated browser, including the application
  name, error scoping, mobile layout, rejection and continuation.
- Separate connector: 361 tests, build and lint passed (four pre-existing lint warnings).

## Production smoke check

- `/api/health` returns `{ "ok": true, "version": "0.1.0" }`, the service is active.
  The vault is unlocked again after the last restart (`locked: false`).
- `/api/coolify/<coolify-server>/databases` now returns six databases including `acme-billing-db`,
  DB `acme_billing`, container UUID `<container-uuid>`.
- Discovery of request #2 automatically selected the verified `acme-billing` on `<coolify-server>`
  in the `production` environment. The request stays `pending`, `operationId: null`;
  the check created neither an approval nor production SQL.
- Three already existing sessions received the CLI, guide and shim without a container restart.
  The fourth, newly created session already uses the new image. In all four,
  `prod-db list` and the fingerprint check of four files passed. None has a mount of the private
  production tunnel key.
- The Coolify MCP configuration in existing profiles was extended only with
  `NODE_OPTIONS` for the shim; the rest of the configuration was preserved. The supported
  `config/mcpServer/reload` on the existing host Codex app-server returned
  `result: {}`. The change applies to its loaded threads on the next active turn.
- Running standalone CLI/MCP processes without a control API were not forcibly restarted.
  For them, the shim is loaded on the next MCP start/reconnect. In Claude,
  `/mcp reconnect all` can be used; no command was sent to any live conversation.
- The Operations form was opened and visually checked directly on the deployed
  dashboard. The final form shows `acme-billing-db · production · <coolify-server> · acme-billing`,
  technical details are collapsed and errors from unrelated DBs are no longer shown.
  Neither prepare, approve nor reject was pressed on the production request.

## Recovery and remaining steps

The host record `/var/lib/devd/releases/prod-db-onboarding-20260910` contains
a manifest with source SHAs, the original diff, a backup of overwritten sources and SQLite, the original image,
the merged stage and test/build logs. The backup files are accessible only to the host.
The original dashboard assets remained available for already open browsers as well.

Deploying the fix does not by itself approve DB access or a migration. For actual onboarding,
a specific Operations decision remains, plus any steps the preflight lists
(for example the right to create an item in 1Password or adding a known fingerprint).
This check created no new production access and did not run the account/systemd
installation script on the database server. The completed `acme-billing` migration is not repeated.
