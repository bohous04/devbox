# Multiple ChatGPT accounts for Codex

Subscriptions → **ChatGPT accounts** manages additional ChatGPT logins independently
of the original account. Add a name, open the displayed OpenAI sign-in page, and
enter the device code using the intended ChatGPT account. Device login must be
enabled for that account. Duplicate subscriptions are rejected.

Each account shows its own quota measurements. Choose **Use for new launches** or
automatic selection, which compares the account's busiest quota window. Disabling
an account excludes it from automatic selection. Existing Codex processes keep
their account; there is no interruption or mid-turn switch.

Additional accounts use persistent Docker profiles with their own credentials,
history, SQLite databases and writer locks. They run independently of Codex Remote.
The original account retains its existing home and Remote server. Remote access
for additional accounts and the `Claude + GPT` proxy profile are outside this change.
This separation follows the current Codex runtime: authentication belongs to the
app-server, and writer locks belong to `CODEX_HOME`.

Account settings and measurements contain no credentials. OpenAI credentials stay
in the account's Docker volume. The quota reader mounts authentication read-only;
token renewal remains the Codex CLI's responsibility. A stale measurement can
recover after the account is used in Codex and **Refresh** is pressed.

New containers receive the current account mounts. Existing containers need to be
recreated using the existing session controls before they can use a newly added
account. Reopening an unchanged container alone does not add Docker mounts. Finish
running work before recreating a container. Removing an account refuses volumes
still referenced by containers, including stopped containers; disabling it is
available immediately. Account deletion also removes its independent history.

The launcher retains the account in the tmux pane for later resumes. For explicit
selection in a fresh shell, use `DEVD_CODEX_ACCOUNT_ID=<id> co`; IDs are returned by
`GET /api/codex-accounts`. Account selection is scoped to native Codex launches.

Shared model settings and MCP definitions are seeded once. Automatic seeding never
copies account auth, history, Remote state or MCP OAuth credentials. Additional accounts may
need their own plugin installation and MCP OAuth sign-in.

## Changing the account in a running session

Expand a running Codex session in **Sessions** and use **Codex account → Switch
account**, or press **F9 → Change account (Codex)** from its terminal. Both show the
actual account of the running Codex panels and let you choose an enabled, signed-in
account mounted in that container. **Refresh accounts** updates the dashboard row.

Confirming restarts the affected Codex panels and **continues the same
conversations** on the selected account. The switch transfers the selected
conversation's saved context and related subagent history, retaining its exact
ID. Panels already on the selected account are left alone. Unfinished turns may
be interrupted. Unrelated conversations and the shared Codex Remote server keep
running.

The service checks mounts and credentials before restarting anything, verifies
the exact conversation and account of each replacement process, and reports
partial failures. Missing or ambiguous conversation identity, conflicting saved
history, or an unsuccessful resume stops the switch with an error; it never falls
back to a new conversation. Account credentials and whole SQLite databases are
not transferred.
If restarting a panel fails, its pending conversation is retained and **Finish
switching** retries the exact continuation. A pending panel cannot be silently
omitted from the session's success result.
The selected account also applies to new tmux windows for the remainder of this
container's tmux session. Recreating or restarting the container follows the
existing launcher selection rules. Missing profile mounts require an explicit
container recreation after finishing work; the switch never recreates it itself.

For native Claude Code, **F9 → Change account (Claude Code — automatic selection)**
uses the same existing account-pool policy as `dev switch`. It preserves its
project rules and resumes the exact current Claude conversations. If the current
conversation cannot be verified, it reports an error instead of starting a new
one. Other
Claude provider profiles do not show this action.

API: `GET /api/sessions/:id/codex-account` returns current panels and available
accounts. `POST` to the same route with `{ "accountId": "…" }` performs the explicit
switch. HTTP 200 with `ok: false` is a partial or failed operation, not success.
Neither response contains credentials. This addition requires a daemon/dashboard
update, an updated local `dev` CLI for F9, and the updated Codex Remote launcher.
Remote resume preserves the conversation's saved permissions instead of passing
permission overrides rejected by Codex 0.154. The launcher can be updated in
existing containers without restarting their agents; new containers use the
updated image. Existing account profile mounts remain required.

## Integration and verification

The feature branch is based on `f3f19e0`. Production also has uncommitted Codex
Remote routing changes. Integrate the additions into its existing `image/co` and
`image/Dockerfile`; replacing those files with the branch versions would discard
Remote wiring. Source the account helper before the existing Remote dispatch and
pass `CODEX_ACCOUNT_ARGS` to the direct Codex exec. Keep the existing
`DEVD_CODEX_REMOTE` condition and the `codex-remote` image asset.

Deploy the daemon, dashboard and rebuilt image together. Existing running sessions
do not need to be interrupted. This change does not itself deploy or sign in to a
real account.

Focused verification:

```sh
bun test devd/test/codexAccounts.test.ts devd/test/codexAccountProfiles.test.ts \
  devd/test/codexAccountLaunch.test.ts devd/test/codexPoller.test.ts \
  devd/test/codexUsageFetch.test.ts devd/test/subscriptionsApi.test.ts \
  devd/test/accountsApi.test.ts dashboard/src/subscriptionsView.test.ts
bun run typecheck
bun run build:dashboard
```

The browser checks cover desktop/mobile layouts and simulated device-login,
quota, preference, disable, remove and failure flows. Real OAuth login and a
two-account runtime smoke require the user's accounts after deployment.

Verified on 2026-09-10: 159 focused Bun tests, dashboard build and full feature-branch
typecheck; 14 browser flows plus a 320px deletion-confirmation check. Against the
merged production snapshot, account API/launcher tests and the five existing
central Remote launcher tests passed, as did the production source typecheck.
The wider snapshot has an existing failing `remoteRestore.test.ts` fixture missing
`removeStopped`; both that test and `restoreSession.ts` are unchanged by this patch.
That unrelated fixture also prevents a full snapshot typecheck including all tests.

Authentication reference: [OpenAI documentation](https://learn.chatgpt.com/docs/auth).
