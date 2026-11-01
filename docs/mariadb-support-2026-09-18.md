# MariaDB access support — 18 September 2026

The `portal` proposals were blocked because the host onboarding, wire proxy,
write executor and `prod-db connect` supported PostgreSQL only. Request #13 also
retained a read-only plan after its requested scope increased to DML. Request #4
had previously been rejected and remains rejected.

## Implementation

- MariaDB uses a separate server-first listener on the Docker bridge. The default
  port is PostgreSQL proxy port + 1 (15433); `DEVD_MYSQL_PROXY_PORT` overrides it.
  Firewall setup denies ingress from eth0 before allowing Docker address pools.
- Both sides perform native password authentication independently. Session
  credentials are random, process-local and revocable; the real password stays
  on the host. Wrong passwords, wrong database, locked vault, invalid framing,
  revoked credentials and upstream authentication failures fail closed.
- After authentication the negotiated protocol is spliced, including binary
  prepared statements and multiple result sets. Compression, client TLS, local
  infile and session-tracking extensions are not negotiated. The remote hop uses
  the existing restricted SSH tunnel; the listener binds only to the bridge.
- The host invokes the database administrator inside the selected Docker
  container. Root credentials never leave that container. Dedicated accounts use
  a host-only ownership ledger plus password-hash matching for safe retries.
  Existing unrelated accounts are never adopted. Database names in grants escape
  wildcard underscores. RO gets SELECT, DML gets SELECT/INSERT/UPDATE/DELETE,
  migration gets database-scoped table/view DDL. No global or grant privileges.
- The catalog is published only after actual tunnel login and role verification.
  The original SQL proposal remains separate from access setup.
- MariaDB DDL can commit implicitly. Preview is static; execution failures report
  possible partial application and are never automatically retried.
- The CLI supports MariaDB URLs. SQL cards display the access engine, concrete
  blockers and rejected access decisions; blocked SQL proposals can be rejected.
- MySQL itself remains unsupported by onboarding. Integration was verified with
  the official MariaDB 11.4 image, mysql2 3.24.4 and the native MariaDB client.

## Validation

- 70 targeted regressions passed (onboarding, SQL approval, credential targets,
  PostgreSQL proxy, URLs and CLI).
- Two integration tests against an isolated MariaDB passed: real provisioning
  scripts and retries, role grants, denial across databases, native CLI and
  prepared queries through the proxy, DML versus DDL, locked/revoked credentials,
  saved SQL approval and duplicate execution protection.
- TypeScript checks and dashboard production builds passed locally and on devbox.
- Browser fixture tests passed, including concrete blockers, rejection, desktop
  and mobile screenshots, no horizontal overflow and no script errors.

## Deployment

Applied only this change's patch to `/opt/vps-dev-infra`, preserving pre-existing
edits to operations and their tests. The source/dashboard rollback archive is
`.local/mariadb-support-20260918/rollback-source.tar.gz`; the previous image is
`devbox:pre-mariadb-20260918`. The updated CLI was installed in 13 running sessions
and in a thin `devbox:latest` image layer. Source Dockerfile already copies it on
the next full rebuild.

After restart, health passed and both proxy ports were listening. The new port
was reachable from `dev-games-game_web-2`. After the user unlocked the vault,
request #13 was re-prepared with DML scope. Operation #86 completed host setup
and role/tunnel verification, then saved the catalog and project grant. A live
read-only query through `prod-db connect portal` returned database `portal`
and account `portal_ro@%`. The actual session uses the Oracle MySQL client;
the CLI now selects `--ssl-mode=DISABLED` for it and `--skip-ssl` for MariaDB
clients, with both variants covered by CLI tests.

SQL #22 is pending its separate approval. SQL #21 remains blocked by the earlier
rejected access request #4; it was not reopened. No gameplay/application SQL was
approved or executed by this task. The temporary MariaDB fixture container and
its volume were removed. Code is deployed but not committed or pushed.

References: [MariaDB native authentication](https://mariadb.com/docs/server/reference/plugins/authentication-plugins/authentication-plugin-mysql_native_password),
[MariaDB connection protocol](https://mariadb.com/docs/server/reference/clientserver-protocol/1-connecting/connection),
[account creation](https://mariadb.com/docs/server/reference/sql-statements/account-management-sql-statements/create-user).
