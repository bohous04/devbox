# Anthropic account pool — runbook

Two Anthropic accounts that share the load, so that the limits of one do not stop
work. Runs on the devbox (devd) and on the mac (shim).

## How an account is chosen

The client (a container at session start, or the mac shim) asks for a **lease** at
`GET /api/accounts/lease`. The decision is made by the pure function `chooseAccount`
(`devd/src/accountPolicy.ts`) in this order:

0. **Pinning** (`projectAccounts`): a project listed in the map gets **only**
   its account; conversely, a project outside the map **may not** use any account that
   is the target of someone's pin. The filter runs before the exhaustion threshold and
   before hysteresis, so not even a manual `dev switch` (`force`) bypasses it. An exhausted
   pinned account **is not an error** — the session starts with `exhausted: true` and waits
   for the reset (the `all-exhausted` branch), the same as with an unpinned pool. Single-account
   mode (`soloAccountId`) overrides even pinning — the dashboard shows a banner for it.
1. Disabled, quarantined and **exhausted** accounts **drop out** (above `thresholdPct`,
   default 90 % on the 5h or 7d window).
2. When nobody is left, the one that frees up **as a whole** first is returned, and the
   session starts anyway — the limit may not bite yet, and blocking the start would be worse.
3. **Preferred account** (`preferredAccountId`): as long as neither of its windows
   has touched `spilloverPct` (default 60 %), it is used **exclusively**. The load of
   the others does not matter at that point.
4. Past the spillover threshold, the choice is made among all accounts by load (lowest % wins),
   with hysteresis and a cooldown against flip-flopping.

The spillover threshold is checked on **each window separately, and one is enough** — whichever
window touches it first decides. After the window resets, the spillover closes again.

`preferredAccountId: null` (default) disables the preference and the pool runs purely by
load. **A manual `dev switch` (`force`) skips the preferred-account gate.**

### Configuration

In `settings.accountPool` in the devd config (`/etc/devd/config/config.json`).
Missing fields are filled with defaults, so it is enough to list what changes:

```json
"accountPool": { "preferredAccountId": "max20", "spilloverPct": 60 }
```

| field | default | what it does |
|---|---|---|
| `preferredAccountId` | `null` | id of the preferred account; `null` = no preference |
| `projectAccounts` | `{}` | map project → account id; empty = no pinning |
| `soloAccountId` | `null` | manual single-account mode; overrides pinning and preference |
| `spilloverPct` | `60` | soft threshold: the preferred account stays on offer, it just gets company |
| `thresholdPct` | `90` | hard threshold: the account drops out of the offer entirely |
| `hysteresisPct` | `10` | how many percentage points better a candidate must be to switch |
| `cooldownMinutes` | `5` | minimum interval between switches |
| `activePollSec` / `idlePollSec` | `60` / `300` | quota measurement cadence |

A config change takes effect **immediately**, without restarting devd — `settings()` is read on every
request.

The preferred account, the `spilloverPct`/`thresholdPct` thresholds, single-account mode and the pin
editor can also be controlled from the dashboard (Settings → "Account pool" section) — without
editing the config by hand. `hysteresisPct`, `cooldownMinutes` and the poll intervals are
not there, though; they remain config-only.

## The account id is not just a label

The `id` is also:

- the docker volume name — `claude-acct-<id>`
- the profile path in the container — `CLAUDE_CONFIG_DIR` at `<PROFILE_ROOT>/<id>`
- the profile directory on the mac — `~/.claude-pool/accounts/<id>`

On top of that, `accountMountList` mounts **all** profiles into **every** session
container. A rename is therefore not an `UPDATE` but a data move, and it forces a recreate of
running containers.

The plan cannot be told from the id — it is in the **label**, where the poller appends it from `rateLimitTier`
as `(Max Nx)`. The dashboard shows it from the label as a badge next to the name.

## Adding an account

An account is set up by **logging in twice with the same account** — once into the profile on the mac,
once into a temporary directory whose blob is uploaded to the devbox. The separate grants
are intentional, so that the mac and the VPS do not rotate each other's refresh token.

```bash
# 1) profile on the mac
CLAUDE_CONFIG_DIR=~/.claude-pool/accounts/<id> claude auth login

# 2) separate grant for the devbox
tmp=$(mktemp -d)
CLAUDE_CONFIG_DIR="$tmp" claude auth login
curl -X POST http://<vps-tailnet-ip>:4300/api/accounts \
  -H 'content-type: application/json' \
  -d "$(python3 -c 'import json,sys;print(json.dumps({"id":"<id>","label":"<mail>","credentials":open(sys.argv[1]).read()}))' "$tmp/.credentials.json")"
rm -rf "$tmp"
```

Instead of a file, the blob may live in the Keychain — see below.

## Removing an account

Dashboard → account card → **Remove**, or `DELETE /api/accounts/<id>`.

`docker volume rm` **refuses** the account's volume while a single session is running — each one
mounts all profiles (`accountMountList`). That is the normal state, not an error, so
removal does not stop there: instead of being deleted, the profile is **emptied**
(`find /profile -mindepth 1 -delete`), the DB row disappears and the response returns
`{"removal":"purged","leftoverVolume":"claude-acct-<id>"}`.

So a live refresh token does not survive on disk in any case — only an empty
volume shell remains. After all sessions have been recreated, delete it:

```bash
docker volume rm claude-acct-<id>
```

When nobody holds the volume, it is deleted right away and `removal` is `removed`. Any other
docker failure (daemon unavailable) is a `502` and the account **stays** in the DB — at that point we know
nothing about the state of the profile.

## Renaming an account

The `tools/rename-account.ts` script, **run on the VPS**. The default mode is a dry-run.

```bash
ssh <devbox-host>
cd /opt/vps-dev-infra
bun tools/rename-account.ts primary max5              # dry-run
bun tools/rename-account.ts primary max5 --commit     # real run
```

The script copies the contents into a new volume and deletes the old one only after verifying that the
credentials in the target are in place. It is idempotent.

When running containers hold the volume, it refuses to continue by default. With `--allow-busy`
it finishes the migration and only **leaves the old volume on disk**:

- nothing changes under the feet of running agents — their `CLAUDE_CONFIG_DIR` still points
  to the mounted old path,
- every **new** Claude session in such a container gets a lease on the new id, whose
  mount it does not have; `account-lease` stays silent in that case and falls back to the shared `claude-home`
  (fail-open, not a logged-out agent),
- those sessions therefore **do not go through the pool** until recreated,
- after all sessions have been recreated, `docker volume rm claude-acct-<old-id>` remains — a live
  refresh token sits there.

On the mac it is then just:

```bash
mv ~/.claude-pool/accounts/primary ~/.claude-pool/accounts/max5
```

Nothing more — the symlinks in the profile point into `~/.claude` and none of them contains the id.

After the rename, do not forget `preferredAccountId` in the config if it pointed to the old
id, and the **recreate of session containers** (they have the old paths in `CLAUDE_CONFIG_DIR`).

## macOS: Keychain vs. file

`claude auth login` on the mac **does not store `.credentials.json`**, but a Keychain
item. The service name is `Claude Code-credentials-` + **the first 8 hex characters of the
sha256 of the config dir's absolute path** (the default profile has no suffix):

```bash
printf '%s' "$HOME/.claude-pool/accounts/max5" | shasum -a 256 | cut -c1-8
security find-generic-password -w -s "Claude Code-credentials-<hash>"
```

**But the file is enough.** Verified for real: `claude auth status` from a path whose hash
is not in the Keychain reports `loggedIn: true` if `.credentials.json` lies in that directory.
That is why renaming a profile is a plain `mv` and there is no need to re-key the
Keychain.

## Deploy

Restarting devd **does not take down** running session containers.

```bash
ssh <devbox-host>
cd /opt/vps-dev-infra && git pull --ff-only
bun run build:dashboard
systemctl restart devd
curl -s http://<vps-tailnet-ip>:4300/api/health
```

## Pins currently in effect

```json
"projectAccounts": { "acme/agent-system": "max5", "acme/solo-1": "max20" }
```

The key is looked up from the more specific one: `project/repo`, then `project`. The ACME review queue
(which runs on `agent-system`) therefore stays on the small account and the interactive
`solo-1` on the large one; the other acme repos are not pinned and follow the normal
policy (preference + spillover).

**A repo-level pin DOES NOT RESERVE THE ACCOUNT** — only project pins (a key without a
slash) reserve. If it did reserve, `acme/solo-1 → max20` would take max20 away from all
other projects and they would be left without a candidate, i.e. in a silent fail-open.

**Until 2026-08-23 there was a project pin `acme → max5` here — and it was precisely its reservation
that brought the pool down.** On a two-account pool, the rest of the world had a single candidate
(max20); as soon as max20 crossed `thresholdPct` (7d window at 98 %), every non-acme
lease ended up in the `all-exhausted` branch on the exhausted max20, while max5 sat at
48 % and the spillover had nowhere to flow. From the outside it looked like "account switching
does not work"; in reality the policy was just obediently enforcing the reservation. That is why the
pin is narrowed to repo-level, which does not reserve.

## Scheduled ACME review queue

The "ACME review queue" run (daily at **6:00**) reviews the three oldest items in the
Review state of the ACME project. It runs on `acme/agent-system`, so thanks to the
repo pin it lands on **max5**. The procedure is versioned in the acme repo as
`.claude/commands/review-queue.md`.

**Why 6:00:** `ccUpkeep` runs in the 3:00–5:00 window and restarts claude panes to update `cc`
— a run scheduled into that window would risk a restart in the middle of a review.

The run does not touch production code and stages **only** its own `review.md` (the acme
repo workspace is often shared with in-progress interactive work). The result comes as a PR, so
nothing lands in `main` without your merge.

**Watch out for a collision with a running session.** The scheduler skips the run (`schedule_skip`)
when the session `dev-acme-agent-system` is currently running — protecting in-progress
work. In normal operation this is fine: the 6:00 run works for ~15 minutes and auto-stop
(`autoStopHours`, default 4 h) closes it around 10:00, so by the next morning the
session has long been stopped. **It bites after a manual run at night:** a run started
at 2:00 is closed by auto-stop at 6:14 — fourteen minutes AFTER the cron, and the morning run is
skipped. This happened on 2026-08-07. After a manual run outside the usual time, better stop the session
right away.

## Things to watch out for

- **The mac shim does not install itself.** It sits in front of every `claude` launch
  (`~/.claude-pool/bin/claude` in PATH), so it is enabled deliberately.
- **There is no automatic switching of a running session.** It stays manual via
  `dev switch`, because a restart in the middle of a turn destroys that turn. In the dashboard a
  session has a "Switch account" button with the same effect (it also shows the account it
  runs on) — but only for a session that is in the pool at all; without an `accountId` there is
  nothing to switch to.
- **Adding a pin does not move a running session.** `CLAUDE_CONFIG_DIR` is set
  at agent START (agent-launch.sh), not on every request, so writing a
  new pin into the config does not affect a running session at all — the acme session keeps
  running on the old account until someone manually switches it (`dev switch` / the
  "Switch account" button) or restarts it. The new pin applies only to the NEXT lease.
- **Before enabling a pin for the first time, verify the target profile's mount in the container.**
  `switchAccount` (nor the lease endpoint) does not check whether the container has the
  profile of the given account MOUNTED at all — `accountMountList` mounts all
  accounts into EVERY session container, but only those that existed at the time the
  container was created (see "The account id is not just a label" above). A container created
  BEFORE the pinned account existed thus gets `/exit` (killing the
  in-progress turn) and claude starts with `CLAUDE_CONFIG_DIR` pointing into a
  nonexistent directory — logged out, without history. Verification:
  `docker inspect <container> | grep claude-acct-<id>`. When the mount is missing,
  the session must be **recreated, not switched** (`dev switch` has no
  protection for this; it would silently try and fail).
- **A project pin on a small pool disables spillover for everyone else.** It reserves
  the whole account, so unpinned projects share the rest — on two accounts that is
  a SINGLE candidate, and once it is exhausted everyone runs on the exhausted account
  (`all-exhausted`), even though the reserved one has room. This happened on 2026-08-23 (see
  "Pins currently in effect"). As long as the pool has two accounts, use repo-level
  pins, which do not reserve.
- **Watch out for fail-open with pinning.** When the pinned account does not exist, is
  disabled or quarantined, the session gets no account and falls back to the shared
  `claude-home` — but that one is logged in with a specific identity, so the work flows
  to an account **outside the pool's records**. Devd warns about this with a notification (`pinAlerts`,
  devd/src/accountAlerts.ts); in addition, the dashboard shows `unknown account` for a pin on a nonexistent id
  (a disabled/quarantined but existing account does not get this label —
  it can only be recognized from the notification or from the account state in the "Anthropic
  accounts" section, not in the "Accounts" section — that one is only the Claude/Codex CLI login and
  has nothing to do with the pool). Three shapes of fail-open that `pinAlerts` reports:
  1. a specific pin points to a missing/disabled/quarantined account;
  2. `soloAccountId` points to a missing/disabled/quarantined account — a WORSE state,
     it hits **every** session, not just one, and the dashboard banner turns
     red for it;
  3. exclusivity: no account is left for unpinned projects, because
     the only/all unreserved accounts are disabled or quarantined — the pin itself
     may be fine, the trouble is on the other side of the map. With solo
     mode enabled, pins are skipped entirely (solo overrides pinning), so they are
     not reported — only a broken `soloAccountId` is reported (item 2).
- **The dashboard is not type-checked by the root `tsc`** — `tsconfig.json` has
  `exclude: ["dashboard"]`. The real gate is
  `bunx tsc -p dashboard/tsconfig.json --noEmit`.
- The remaining open items are in [account-pool-followups.md](account-pool-followups.md).
