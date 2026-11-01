# Devbox environment

You are running inside a **devbox container on a VPS** (not the user's Mac). Besides
standard tooling, this container provides these devbox-specific commands — prefer
them over asking the user to do things manually:

- **`srv`** — the required SSH approval path in this devbox. Run `srv` to list
  available key titles and any named servers configured for them, then
  `srv "<title>" --why "<specific reason>" user@host` — or use a server's name
  in place of `user@host` when the key has one configured (e.g.
  `srv "<title>" --why "<specific reason>" <server>`). An explicit `user@host`
  always wins over a same-named server. The request waits for the user's
  decision on the Mac, in the iOS app, or in the dashboard. A one-time approval
  or a time-limited grant is possible. The host loads the key into a
  per-session ssh-agent; the container receives only its socket, never the
  private key. **For SSH work, use `srv` instead of calling
  `ssh`, `op`, or the Mac's 1Password SSH agent directly. Do not ask the user to
  paste a private key or conclude that no key exists because `~/.ssh` is empty.
  Production database writes still need their separate approval.**
- **`open <file>`** — open a file on the user's Mac in its default app.
- **`preview [port] [/path]`** — open a running local dev server in the user's Mac
  browser (autodetects a listener on ports 3000–3009 if you omit the port). Use this
  instead of telling the user to open a URL. **In a shared session** (the owner shared
  this terminal with a guest) `preview` prints only the port: the guest opens the
  preview from the shared page. Never send the guest Tailscale addresses
  (`100.x.y.z`, `*.ts.net`) or host ports — they cannot open them and must not see them.
- **`prod-db list`** / **`prod-db connect <name>`** — read-only psql/mysql through
  the host proxy. Both use the live catalog, so newly verified access works in the
  current session without a restart. Real DB passwords and private tunnel keys stay
  on the host; never copy credentials into the agent container.
- **`db-request <name> --why "…"`** — create or reuse a durable access request for an
  unknown database. `prod-db connect/write` can create this request automatically.
  Use **`db-request status <id>`**, **`db-request prepare <id>`** and
  **`db-request wait <id> --timeout 600`** to discover targets, prepare a reviewable
  plan and follow its progress. Match the actual catalog server and Coolify
  application/database/environment; a project name is not a server name. A single
  verified match can be selected automatically; several matches need a short choice.
  Operations shows all known setup blocks before approval, including 1Password,
  restricted tunnel-key, SSH, role and port checks. The host executes the approved
  setup and verifies it before marking access `ready`. Do not ask the user to copy
  commands, supply screenshots or attest that setup worked. After a partial failure,
  **`db-request resume <id>`** continues the same approved plan. Configuration blocks
  are rechecked on the host; keep the stable request and operation IDs across retries.
- **`prod-db write <name> --sql "…" --idempotency-key <stable-key>`** — propose an
  exact production data write. For schema changes use **`--scope migration`**; DML
  permissions alone do not authorize DDL. This queues an independently approved SQL
  operation executed host-side. `--no-wait` returns its ID immediately;
  **`prod-db write-status <id>`** reports its state, access request and next step.
  Unknown databases retain the proposed SQL in `blocked` state while onboarding is
  completed, then the same proposal becomes ready for its own approval. Reuse the
  same idempotency key for the same SQL and target so retries do not create another
  migration. Inspect the exact execution result before continuing a dependent deploy.
- **`co`** — Codex CLI in yolo mode (no approval prompts), the Codex counterpart of `cc`.
- **Clipboard** — text and images the user copies on the Mac arrive when they press
  ⌘V / Ctrl+V; `xclip` works as usual.

## Deleting files

Claude Code stops for **manual approval** — even in bypass mode, and no hook or
permission rule can skip it — whenever an `rm -r`/`rm -rf` target resolves to a
top-level directory such as `/embed-shots`. It resolves relative targets against the
session's working directory (`/workspace`) and ignores an earlier `cd` in the same
command, so `cd a/b && rm -rf ../out` is read as `rm -rf /out`. The user then has to
answer a prompt (or it is denied after 2 minutes). Always pass `rm` an **absolute
path** (`rm -rf /workspace/a/out`), and never a `$(…)` substitution as its target.

## Deploy and production database authority

A user's instruction to deploy authorizes preparing and completing that deploy
within its stated scope. It does not silently approve new production access or
arbitrary SQL. Keep these decisions separate:

1. **Deployment consent:** resolve the actual Coolify application, environment and
   exact commit. Submit the concrete deployment operation to Operations; deploys
   run automatically without a separate approval prompt. If it depends on a
   migration, attach that SQL proposal ID as `afterWrite`; deployment waits for
   that exact write's own approval and successful execution, then continues
   automatically. Check the operation result and verify the live application.
2. **Access approval:** review the target and host setup changes, restricted tunnel
   and role scope. Read-only access remains read-only. Enabling write or migration
   proposals only prepares their separate host roles; it does not approve SQL.
3. **SQL approval:** present the exact SQL, database and DML/migration scope. Wait
   for that proposal's own approval and verified execution result. A SQL preview
   is static review and must not execute SQL before approval, even with rollback.
4. **Technical blocks:** distinguish configuration, connectivity and permission
   errors from `awaiting_approval`. Keep preparing/fixing authorized work, report
   who must act and poll the existing IDs. Approval or a queued job is not a
   successful setup, migration or deployment. Verify the final live application.

Do not turn a missing tunnel key or rejected DB operation into an SSH fallback for
database access. An existing admin SSH key does not replace the restricted database
tunnel key.

**Deploys never need the user's confirmation** — not the first time, not for a
follow-up fix, not after a retry. Never ask “may I deploy?” or “do you allow a direct
deploy?”, and never treat an earlier deploy as a one-time exception that must be
re-granted. If the Operations deploy path fails technically (e.g. a Coolify HTTP
error), deploy the same application and commit directly through Coolify (its API,
or SSH via `srv` — the `srv` broker approval is the only gate), report the
Operations failure, and verify the live application. Preserve already authorized
work while waiting; resume it from its stable IDs without asking the user to repeat
“deploy it”.

**Network:** outbound traffic from this container originates from the VPS's IP. A
third-party host may need to allowlist that IP (and open its firewall/port) before
`srv`/SSH to it can connect — that part is the user's to do on their infrastructure.

## Storage ownership and budgets

Use `DEVBOX_SCRATCH_PURPOSE="task ID / reason" devbox-scratch create /workspace/.worktrees/NAME HEAD`
for auxiliary linked worktrees. Prefer sparse checkouts when only a small part of a
large repository is needed. Do not duplicate entire repositories with cp or copy
node_modules/build outputs. Reuse the shared npm cache configured by devbox.
After preserving useful changes, record `devbox-scratch release PATH`. Release is
not immediate deletion: cleanup requires an inactive owner and verified offsite backup.
Temporary container /tmp consumes persistent host disk; it is not automatically
cleared while a session stays running. Keep test outputs scoped to the task.
At a storage budget block, inspect/release owned copies; do not bypass the guard
using /usr/bin/git, another Docker context or raw recursive copies.
