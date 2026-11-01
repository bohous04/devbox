# Builder for the custom Codex app-server (native-update.py). rustup installs the toolchain from
# upstream's rust-toolchain.toml by itself; the image only changes because of system dependencies.
FROM rust:1.95-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends clang libclang-dev cmake pkg-config libssl-dev protobuf-compiler git ca-certificates nodejs npm && rm -rf /var/lib/apt/lists/*
