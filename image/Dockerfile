FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# Base packages + official upstream apt repos (gh, charm/glow, docker cli, node 22)
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg git zsh tmux jq unzip ripgrep fzf \
      build-essential python3 python3-venv sudo openssh-client rsync locales less \
      postgresql-client default-mysql-client lua5.4 \
    && install -d /etc/apt/keyrings \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli.gpg \
    && echo "deb [signed-by=/etc/apt/keyrings/githubcli.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
    && curl -fsSL https://repo.charm.sh/apt/gpg.key | gpg --dearmor -o /etc/apt/keyrings/charm.gpg \
    && echo "deb [signed-by=/etc/apt/keyrings/charm.gpg] https://repo.charm.sh/apt/ * *" > /etc/apt/sources.list.d/charm.list \
    && curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg \
    && echo "deb [signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu noble stable" > /etc/apt/sources.list.d/docker.list \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get update && apt-get install -y --no-install-recommends gh glow docker-ce-cli nodejs \
    && rm -rf /var/lib/apt/lists/*

# Bun + uv (arch-aware official installers), pnpm + Codex via npm.
# Claude Code is deliberately ELSEWHERE — see the layer with ARG CC_VERSION below.
RUN curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash \
    && curl -LsSf https://astral.sh/uv/install.sh | UV_INSTALL_DIR=/usr/local/bin sh \
    && npm install -g pnpm @openai/codex

# Grok Build (xAI). The version is PINNED via the installer's positional argument — verified
# by research (Task 7): `bash -s X.Y.Z`, validated by a regex inside install.sh.
# Without a pin the image would drift over time, same as with CC_VERSION.
#
# HOME=/opt/grok is a necessity, not cosmetics — the same trap as with serena below (:46) and
# playwright above (:34). The installer drops into `$HOME/.grok` and RUN runs as root, so
# without redirection the binary ends up under /root/.grok (mode 0700) and `/usr/local/bin/grok`
# is only a symlink to it. User `dev` (uid 1000) cannot see into /root → "grok: command not
# found", i.e. a dead `grok` profile, a dead login in the dashboard and a dead Grok branch
# v tools/agent-sync.ts.
#
# GROK_BIN_DIR=/usr/local/bin: the installer symlinks into /usr/local/bin by itself only
# when BIN_DIR is NOT on PATH — with this the target is on PATH directly and the symlink is created right there.
#
# `rm -f /usr/local/bin/agent`: next to `grok` the installer also creates an `agent` alias (see
# install.sh, `ln -sf … "$BIN_DIR/agent"`). That is too generic a name to sit
# on PATH in every session — it would collide with anything of its own that an agent names
# `agent`. `grok` is enough, `gr` is our own launcher.
#
# Verification runs as NON-ROOT (`su … nobody`), and that is the essential part: `grok --version`
# as root reported success even when the binary did not exist for uid 1000. A check
# that reports green for a broken thing is worse than none.
ARG GROK_VERSION=1.0.13
RUN HOME=/opt/grok GROK_BIN_DIR=/usr/local/bin bash -c 'curl -fsSL https://x.ai/cli/install.sh | bash -s "${GROK_VERSION}"' \
    && rm -f /usr/local/bin/agent \
    && chmod -R a+rX /opt/grok \
    && su -s /bin/sh -c 'grok --version' nobody

# Antigravity CLI (Google, successor of Gemini CLI for personal accounts — Gemini CLI
# rejects them, see the Antigravity research notes, Question 5). Native binary `agy`.
#
# Installed as root into /opt/agy (same reason as HOME=/opt/grok above): a binary
# in ~dev would self-update in each container separately and the versions would drift.
# `dev` cannot overwrite a root-owned binary; the version is controlled by the image build (confirmed in
# Question 7). The installer cannot pin a version — it takes the latest from the manifest.
# Verification as NON-ROOT, for the same reason as with grok.
RUN HOME=/opt/agy bash -c 'curl -fsSL https://antigravity.google/cli/install.sh | bash -s -- --dir /opt/agy/bin' \
    && ln -sf /opt/agy/bin/agy /usr/local/bin/agy \
    && chmod -R a+rX /opt/agy \
    && su -s /bin/sh -c 'agy --version' nobody

# Playwright MCP — headless Chromium so agents can drive a real browser (tests, scraping,
# screenshots) without a display. Browsers baked to a world-readable path since the
# container runs as uid 1000; the env makes Playwright + the MCP find them there.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
RUN npm install -g @playwright/mcp@latest \
    && node "$(npm root -g)/@playwright/mcp/node_modules/playwright/cli.js" install --with-deps chromium \
    && chmod -R a+rX /opt/ms-playwright

# LSP: the typescript-lsp plugin declares `command: typescript-language-server`, so without
# this binary LSP in the container is dead. As root → /usr/bin, i.e. on PATH.
RUN npm install -g typescript typescript-language-server

# serena (MCP for semantic code reading/editing). All three variables are required: without them
# uv stores both the tool and the downloaded interpreter in /root, which user `dev` (uid 1000) cannot see, and
# `serena` ends with "Permission denied". The system python 3.12 is not enough, serena wants 3.13.
# The variables are only on this RUN, not in an ENV layer: if they stayed set permanently,
# a user's own `uv tool install` in a running container would target the root-owned
# /opt/uv-tools and fail with Permission denied. Serena does not need them after install —
# the venv has absolute paths baked into the shebang.
RUN UV_PYTHON_INSTALL_DIR=/opt/uv-python UV_TOOL_DIR=/opt/uv-tools UV_TOOL_BIN_DIR=/usr/local/bin \
    uv tool install -p 3.13 serena-agent \
    && chmod -R a+rX /opt/uv-python /opt/uv-tools

# Claude Code in its own layer only AFTER playwright: the devd job (ccUpkeep) rebuilds the
# image with `--build-arg CC_VERSION=<version>`, which invalidates this layer and everything
# below it — if it were higher, every cc bump would re-download chromium (hundreds of MB).
# The default `latest` keeps a manual `docker build -t devbox:latest image/` on the old behavior.
# Without the ARG the build would hit the cache and would not pull the new cc version at all.
ARG CC_VERSION=latest
# `claude --version` in the SAME layer: npm exits with zero even when the platform binary
# was not installed. `@anthropic-ai/claude-code-linux-x64` is an *optional* dependency,
# so when it is not on npm yet (on 2026-08-20 it was published 2.5 h later than the main package),
# npm silently skips it and `bin/claude.exe` stays a shell stub reporting "claude
# native binary not installed". Without this check such an image gets tagged as
# devbox:latest and every new session is born without a working cc.
RUN npm install -g @anthropic-ai/claude-code@${CC_VERSION} \
    && claude --version

# dev user (uid 1000): ubuntu:24.04 ships user "ubuntu" with uid 1000 — replace it
RUN userdel -r ubuntu 2>/dev/null || true \
    && useradd -m -u 1000 -s /bin/zsh dev \
    && echo "dev ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/dev \
    && install -d -o dev -g dev /home/dev/.claude /home/dev/.codex /home/dev/.grok /home/dev/.gemini /home/dev/.vscode-server /workspace /run/devd \
    && touch /home/dev/.zshrc && chown dev:dev /home/dev/.zshrc

COPY entrypoint.sh /usr/local/bin/devbox-entrypoint
COPY claude-launch.sh /usr/local/bin/claude-launch
COPY agent-launch.sh /usr/local/bin/agent-launch
COPY devbox-recovery /usr/local/bin/devbox-recovery
COPY recovery/ /usr/local/lib/devbox-recovery/
RUN chmod 755 /usr/local/bin/devbox-recovery
COPY account-lease.sh /usr/local/bin/account-lease
COPY link-shared-profile.sh /usr/local/bin/link-shared-profile
COPY open /usr/local/bin/open
COPY devbox-pty /usr/local/bin/devbox-pty
COPY devbox-tmux-status /usr/local/bin/devbox-tmux-status
COPY playwright-mcp-devbox /usr/local/bin/playwright-mcp-devbox
COPY --chown=dev:dev tmux.conf /home/dev/.tmux.conf
RUN chmod 755 /usr/local/bin/devbox-entrypoint /usr/local/bin/claude-launch /usr/local/bin/agent-launch /usr/local/bin/open /usr/local/bin/devbox-pty /usr/local/bin/devbox-tmux-status /usr/local/bin/playwright-mcp-devbox
RUN chmod 755 /usr/local/bin/account-lease
RUN chmod 755 /usr/local/bin/link-shared-profile
COPY git-credential-devbox /usr/local/bin/git-credential-devbox
COPY cc /usr/local/bin/cc
COPY co /usr/local/bin/co
COPY codex-account-env.sh /usr/local/bin/codex-account-env.sh
COPY codex-account-seed.py /usr/local/bin/codex-account-seed.py
COPY --chmod=755 codex-remote /usr/local/bin/codex-remote
COPY gr /usr/local/bin/gr
COPY ag /usr/local/bin/ag
COPY agy-trust /usr/local/bin/agy-trust
COPY agent-auto-update /usr/local/bin/agent-auto-update
RUN chmod 755 /usr/local/bin/agent-auto-update
COPY srv /usr/local/bin/srv
COPY mac-sync /usr/local/bin/mac-sync
COPY xclip /usr/local/bin/xclip
COPY devbox-ctrlv /usr/local/bin/devbox-ctrlv
COPY preview-relay /usr/local/bin/preview-relay
COPY preview /usr/local/bin/preview
COPY db-request /usr/local/bin/db-request
RUN chmod 755 /usr/local/bin/db-request
COPY seed-devbox-guide.sh /usr/local/bin/seed-devbox-guide
COPY devbox-guide.md /opt/devbox/guide.md
COPY prod-db/catalog.json /srv/prod-db/catalog.json
COPY prod-db/prod-db /usr/local/bin/prod-db
COPY seed-warp-hooks.sh /usr/local/bin/seed-warp-hooks
COPY vendor/warp-hooks /opt/warp-hooks
COPY seed-devd-hooks.sh /usr/local/bin/seed-devd-hooks
COPY seed-codex-hooks.sh /usr/local/bin/seed-codex-hooks
COPY seed-grok-hooks.sh /usr/local/bin/seed-grok-hooks
COPY seed-agy-hooks.sh /usr/local/bin/seed-agy-hooks
COPY vendor/devd-hooks /opt/devd-hooks
RUN chmod 755 /usr/local/bin/git-credential-devbox /usr/local/bin/cc /usr/local/bin/co /usr/local/bin/gr /usr/local/bin/ag /usr/local/bin/agy-trust /usr/local/bin/srv /usr/local/bin/mac-sync /usr/local/bin/xclip /usr/local/bin/devbox-ctrlv \
      /usr/local/bin/seed-warp-hooks /opt/warp-hooks/*.sh \
      /usr/local/bin/seed-devd-hooks /usr/local/bin/seed-codex-hooks /usr/local/bin/seed-grok-hooks /usr/local/bin/seed-agy-hooks /opt/devd-hooks/*.sh /usr/local/bin/prod-db /usr/local/bin/seed-devbox-guide
RUN chmod 755 /usr/local/bin/preview-relay
RUN chmod 755 /usr/local/bin/preview

# Vendored MCP servers that on the Mac live as local scripts: the Plane
# Cloudflare-Access shim (run via `uv run --with plane-mcp-server`). Wired up via
# secrets.json mcpServers → agent-sync.
# Likewise the bridge for the `xcode` MCP (mac-mcp-bridge/) — it calls the real Mac over SSH.
COPY vendor/plane-cf-shim.py /opt/plane-cf-shim.py
COPY mac-mcp-bridge /opt/mac-mcp-bridge
RUN chmod 755 /opt/mac-mcp-bridge/bridge.py /opt/mac-mcp-bridge/ssh_transport.py
# Same for coolify-mcp: it reads its own headers only from argv (`--header`), so without
# the shim the CF Access service token would end up in argv, where `ps` and `mcp list` print it.
# The shim also rewrites deploy GET to POST for older clients. It adds CF headers
# only with COOLIFY_CF_ACCESS_* and does not redirect requests to another target.
COPY vendor/coolify-cf-shim.cjs /opt/coolify-cf-shim.cjs

# The remote Codex server expands plugin hook paths using its private CODEX_HOME.
# Expose only the shared plugins at that path inside project containers.
RUN mkdir -p /var/lib/codex-remote-home \
    && ln -s /home/dev/.codex/plugins /var/lib/codex-remote-home/plugins

USER dev
WORKDIR /workspace
# Without TZ the container runs in UTC, i.e. two hours off from the host — which shows up in
# logs, file mtimes and the times the agent notes down. zoneinfo is in the base image.
ARG TZ=UTC
ENV TZ=${TZ}
ENV SHELL=/bin/zsh
ENV CLAUDE_CONFIG_DIR=/home/dev/.claude
ENV CODEX_HOME=/home/dev/.codex
ENTRYPOINT ["/usr/local/bin/devbox-entrypoint"]

# Storage guard client (infra/storage-guard): /usr/local/bin/git, docker and devbox-scratch
# run admission checks before commands that add copies or builds, then delegate to /usr/bin.
# It only enforces anything when devd marks the session (DEVBOX_STORAGE_GUARD=1) because the
# host runs the guard; elsewhere it is a plain pass-through.
USER root
COPY storage-guard-client.py /usr/local/lib/devbox-storage/client.py
RUN chmod 755 /usr/local/lib/devbox-storage/client.py \
    && ln -s /usr/local/lib/devbox-storage/client.py /usr/local/bin/git \
    && ln -s /usr/local/lib/devbox-storage/client.py /usr/local/bin/docker \
    && ln -s /usr/local/lib/devbox-storage/client.py /usr/local/bin/devbox-scratch
USER dev
