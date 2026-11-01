# Production DB onboarding and follow-up deploy

The current deploy state and production verification are in the
[release record of 10 September 2026](prod-db-release-2026-09-10.md).
Below is the implementation record, including the original state before the release.

Implementation on the branch `fix/prod-db-onboarding`, base
`f3f19e093f05e388caa3402deb2ce9b498698ef1`. The original VPSbetter working copy and its
in-progress changes were preserved. Neither `acme-billing` nor its completed migration was
changed. The following record captures the pre-release verification; the release state is tracked
separately.

## Cause of the incident

Coolify returned the database with `database_type: standalone-postgresql`; devd filtered
only on `type`, so it excluded it. In addition, it used the display name as the container
identifier instead of the UUID. The regression test contains a sanitized real-world format of `acme-billing`
in `devd/test/fixtures/coolify-billing.redacted.json`.

The dashboard derived the server and SSH alias from the project. Now the selection comes from the catalog
and verified Coolify metadata. A single verified match is selected automatically; several
matches offer the application/database, server and environment. Technical details are collapsible.

The installed Coolify MCP 2.12.0 sent deploy via GET. Both devd and a targeted compatible
shim use POST. For a specific commit, the plan explicitly states the change of
`git_commit_sha`: the executor verifies the application, sets and reads back the pin, queues the deployment
in the regular queue via POST and verifies the commit of the returned deployment. The result is
"queued", not a claim that the application runs successfully.
The method and parameters are described by the [Coolify API](https://next.coolify.io/docs/api/endpoints/deployments/deploy-by-tag-or-uuid);
the commit snapshot and deduplication are documented by the [queue implementation](https://github.com/coollabsio/coolify/blob/v4.x/bootstrap/helpers/applications.php).

## New flow

1. `prod-db connect/write` for an unknown DB creates or returns a stable access
   request. The SQL is kept under its own ID as `blocked`.
2. `db-request prepare ID` or Operations determines the target and prepares a concrete plan.
   The preflight before approval verifies the catalog, containers, inputs, ports, 1Password,
   SSH and the required permissions. It returns all detected blocks with a category and the next step.
3. A human approves the prepared operation via the existing Operations gate. The host performs
   fixed, predefined steps, verifies the tunnel and roles, and only then stores the catalog and grant.
   Manual `/command` and `/confirm` return 410 with an instruction to use the prepared operation.
4. The current session reads the live catalog. Access does not require a session restart;
   the database password is replaced by a short-lived credential of the host proxy.
5. Specific SQL and `dml`/`migration` require a separate decision. The SQL preview
   runs nothing. SQL is not retried automatically after an unclear result.
6. An approved deploy with `afterWrite` waits for a specific successful SQL proposal and then
   continues automatically. Rejection or failure of the migration prevents it from running.

The API returns `id`, `operationId`, `state`, `blocks`, `step` and `nextAction`.
Retry/reload use the same plan and ID. Setup is serialized per server; the catalog,
ports, roles and items have conflict checks. A partially completed approved setup
can be resumed; a change of the approved target or scope requires a new decision.
If a migration proposal arrives after a read request, a plan not yet submitted is extended
with the required scope. An already submitted plan does not change; after it completes, polling
the same SQL proposal creates one separate access-extension request.

## Explicit access scopes

Use `db-request DB --why PURPOSE --scope migration` to prepare migration access,
or `--scope dml` for data-write access. The default remains `read`. This creates
an access request only: host setup and each exact SQL proposal retain their
separate approval requirements.

After read access has already been approved, a higher scope creates a separate
access-extension request. Continue with the returned ID and run `db-request
prepare ID`; an existing approved plan cannot be widened by adding flags to
`prepare`. Repeated requests for the same pending scope reuse its ID. Existing
SQL proposal IDs and idempotency keys remain unchanged.

The API accepts `scope: "read" | "dml" | "migration"` on
`POST /api/prod-db/requests`. Unsupported explicit values are rejected. The CLI
also fails if a server returns a lower scope than requested, preserving the
returned request ID for inspection instead of reporting broader access ready.

## Approved MariaDB diagnostic output

MariaDB execution preserves SELECT result sets in the existing proposal result
note, alongside the affected-row count. `prod-db write-status ID` therefore keeps
the diagnostic values after the approval response is gone. The same session and
human approval gates still apply; this does not create a read or execution bypass.
Large integers and dates remain strings in driver results.

Output is bounded to eight result sets, 100 rows per set and 48 KiB of serialized
row data. It records each statement number and returned row count, with explicit
`truncated` flags when rows, bytes or sets are omitted. Truncated output cannot
qualify complete schema metadata. This bounds the stored result, not memory used
by the database driver while fetching an approved query.

Old operations that stored only an affected-row summary cannot recover discarded
rows retroactively. Keep their IDs and outcomes; do not replay SQL solely to fill
in a missing result. A later diagnostic needs its own exact reviewed proposal.

## Permissions and remaining manual steps

- The host creates a dedicated SSH key and Password items if it can verify the required
  1Password permissions. Otherwise it shows the missing items before approval; once they
  are added, it repeats the check and continues with the same request. An unavailable integration is
  a connection error; an insufficient right to create items is a separate block.
  The generation options used are in the [1Password CLI documentation](https://www.1password.dev/cli/reference/management-commands/item).
- The admin identity may come from the catalog or from unambiguous, human-approved
  `srv` metadata for the actual server. Its functionality is re-verified.
  An old SSH grant is not carried over. The admin key must never become a tunnel key.
- Private keys and passwords stay on the host in protected temporary files.
  SSH transfers the public key and the SCRAM verifier. The agent/API never receive real passwords,
  private keys or the raw error output of subprocesses.
- The dedicated SSH account allows only local TCP forwarding to specific loopback
  ports. Shell, PTY, reverse/agent/streamlocal forwarding are forbidden. The loopback
  relay uses systemd and the current address of the verified Docker container.
- RO, DML and migrations have separate roles. Migration requires a safe application
  owner without superuser/CREATEROLE/CREATEDB privileges. A shared or overly powerful
  owner, dangerous PUBLIC grants and privileged functions are blocks; the executor
  does not silently take over ownership of an existing production database.
- A non-standard SSH policy, a missing known fingerprint or an ambiguous
  admin identity may require a one-time fix of the host configuration.
  Automatic onboarding is implemented for PostgreSQL; another engine stops
  before any changes with a specific reason.
- An explicit user exception is stored with the SQL proposal/audit. On its own it does not trigger an SSH
  fallback and does not bypass the separate gates. `image/devbox-guide.md`, from which the
  AGENTS/Claude instructions in the session are prepared, describes this distinction.

## Verification

Final run: **2 184 passed, 34 skipped, 0 failed**, 6 069 assertions,
212 files, 83.97 s. All new PostgreSQL/OpenSSH integration tests were enabled.
TypeScript, the dashboard build, the diff check and the CLI syntax check also passed.

```sh
DEVD_TEST_SSHD=1 DEVD_TEST_PG_PORT=55478 bun test devd/test dashboard/src
bun run typecheck
bun run build:dashboard
git diff --check
bash -n image/prod-db/prod-db image/db-request
```

The integration command requires a pre-started dedicated synthetic PostgreSQL cluster
on a high localhost port and an admin fixture as described in the test headers. Do not use
a production URL/cluster. The cluster of this run and the local Vite fixture were
stopped after verification; ports 55478 and 4179 are freed. The temporary cluster was removed.

The complete isolated application scenario in `dbOnboarding.integration.test.ts` passed through
real PostgreSQL, roles, SCRAM login and the host DB proxy: unknown DB →
preparation → access approval → verification → live catalog → separate DDL approval →
real additive migration → follow-up deploy of a specific SHA via POST.
1Password, remote SSH and Coolify transports are simulated in this scenario.

A separate integration suite uses a real local OpenSSH to verify the allowed
tunnel and the rejection of a shell, a reverse tunnel and another target. The SQL suite uses
a real isolated PostgreSQL for grants, idempotency, DDL and rejection of dangerous
privileges. The Linux account/systemd installation was verified syntactically and via the
tested executor; it was not performed in production nor as a full installation in a Linux VM.

Regressions cover gaps, a project mistaken for a server, multiple candidates, keys,
1Password, rejection, SSH errors, DDL privileges, concurrency, recovery after a partial write
and restart, a non-functional proxy and disallowed approval from the agent's container.

Playwright checks the real React UI with isolated API fixtures, desktop and
mobile, concurrent requests, multiple targets, blocks, an approval error and continuation.
Visually checked screenshots:

- [Prepared plan on desktop](evidence/db-onboarding/prepared-desktop.png)
- [All known blocks on mobile](evidence/db-onboarding/blocks-mobile.png)
- [Separate SQL approval](evidence/db-onboarding/sql-approval-mobile.png)
- [Deploy waiting for the migration](evidence/db-onboarding/deploy-wait-mobile.png)

## Separate connector and release state

The source backport of the connector is kept separately in the working copy
`~/src/coolify-mcp-deploy-post`, branch
`fix/deploy-post-v2.12.0`: only the deploy method, matching tests and the changelog.
Its 361 tests and build passed. It was neither installed nor published. The devbox contains
its own narrowly scoped shim for the existing version; it does not override other endpoints nor
trigger automatic deploy retries.

Sources: [client 2.12.0 with GET](https://github.com/StuMason/coolify-mcp/blob/v2.12.0/src/lib/coolify-client.ts),
[verified upstream 3.1.0 with POST](https://github.com/StuMason/coolify-mcp/blob/d6d8f9d965b22bc847532b3ddb3de347d427c255/src/lib/coolify-client.ts).
The backport was verified with `npm ci --ignore-scripts`, `npm test`, `npm run build`.

A read-only check of the running devbox found the original parser still in place. The production devd
is active on base `f3f19e0`; the remote `devd/src/api.ts` additionally has an existing
in-progress change. A future release must preserve/merge it. This result
cannot be presented as a deployed fix.

The deploy needs a separately authorized release of devd/dashboard and an update of
the image/CLI/instructions in sessions, including a restart of MCP processes for the shim. The new path
does not add a mount of private tunnel keys; old containers may have historical
mounts that a controlled rollout must remove. No other application was changed.

On 10 Sep 2026 the user subsequently authorized the commit and deploy of the devbox. The pre-release
check added rejection of HTTP redirects in the Coolify shim (protection of CF headers)
and atomic identification of the managed SSH account for a retry after an interrupted `useradd`.
The preflight now also verifies all required host commands and the proxyd version.
The separate connector is committed as `1fdabf023196d6171e1d5ca47f81f98bc35b362b`;
neither a global installation nor a publication of the connector was performed.
