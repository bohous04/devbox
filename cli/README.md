# dev CLI

The `dev` command for the Mac. Install from the repo root:

    bun install
    ln -s "$PWD/cli/src/main.ts" ~/.local/bin/dev     # or: bun link --cwd cli (needs ~/.bun/bin on PATH)

Config: `~/.config/devbox-cli/config.json`

    { "devdUrl": "http://<vps-tailnet-ip>:4300", "sshHost": "<vps-ssh-host>" }

Without `sshHost` the CLI runs in local mode (`docker exec` on this machine).

Zsh completions — add to `.zshrc`:

    fpath=(<repo>/cli/completions $fpath)
    autoload -Uz compinit && compinit

Commands: `dev --help`, or [docs/mac.md](../docs/mac.md).
