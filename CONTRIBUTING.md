# Contributing

Thanks for helping. devbox is a small project, so keep changes focused and talk about
bigger ideas in an issue first.

## Development setup

You need [Bun](https://bun.sh) ≥ 1.3, git, Python 3 (for a few script tests) and, for the
full suite, Docker and tmux. Linux matches production. macOS works for most tests.

```bash
git clone https://github.com/bohous04/devbox && cd devbox
bun install
```

Repository layout: see the table in [README.md](README.md#architecture).

## Running tests

Each workspace has its own Bun test suite. Run them from the package directory:

```bash
(cd devd && bun test)
(cd dashboard && bun test)
(cd cli && bun test)
(cd listener && bun test)
bun run typecheck                      # whole repo, from the root
bash infra/test-setup.sh               # setup.sh syntax, idempotency, feature flags
python3 -m unittest discover -s devd/test -p '*_test.py'
```

Run a single file with `bun test test/hardware.test.ts` (from `devd/`). Tests that need a
tool missing on your machine (Docker, Linux-only utilities) are skipped with a reason. CI
(`.github/workflows/ci.yml`) runs everything on Ubuntu.

The iOS app is generated with [XcodeGen](https://github.com/yonaskolb/XcodeGen):
`cd ios && xcodegen generate`, then open `DevboxApp.xcodeproj`. Live tests against a real
devd are skipped unless `DEVBOX_LIVE_TESTS=1` and `DEVBOX_TAILNET_URL` are set.

## Running devd locally

devd runs on a Mac with Docker Desktop for UI and API work:

```bash
DEVD_ROOT=$HOME/devbox-root DEVD_CONFIG_DIR=$HOME/devbox-root/.config \
DEVD_DB=$HOME/devbox-root/devd.sqlite DEVD_SECRETS=$HOME/devbox-root/secrets.json \
  bun devd/src/index.ts
bun run --cwd dashboard dev            # Vite dev server for the dashboard
```

Build the session image with `docker build -t devbox:latest image/` before starting sessions.

## Guidelines

- **Tests come with the change.** Bug fixes get a regression test. Don't weaken or delete
  existing assertions to make something pass. If a test is wrong, explain why in the commit.
- **No personal or install-specific values in code.** Hostnames, IPs, accounts and project
  names belong in configuration ([docs/configuration.md](docs/configuration.md)). Tests use
  `example.com`, `192.0.2.0/24`, `198.51.100.0/24`, `100.64.0.0/10` and made-up names.
- **No secrets, ever.** CI runs gitleaks. Use placeholders such as `__CHANGE_ME__`.
- **English** for code, comments, UI text, docs and commit messages.
- **Commits** follow the existing style: `type(scope): summary`, e.g.
  `fix(devd): keep session ports on restart`. Explain *why* in the body when it isn't obvious.
- **Comments explain why**, not what. Many existing comments record the incident behind a
  rule. Keep that context when you change the rule.

## Pull requests

1. Fork, branch from `main`, keep the PR to one topic.
2. Make sure the test suites, typecheck and `infra/test-setup.sh` pass.
3. Describe the change and how you verified it (tests, manual steps, screenshots for UI).

By contributing you agree that your contribution is licensed under the Apache License 2.0
([LICENSE](LICENSE)).
