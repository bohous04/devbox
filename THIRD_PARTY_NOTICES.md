# Third-party notices

devbox is licensed under the Apache License 2.0 ([LICENSE](LICENSE)). It includes or modifies the
following third-party code, which keeps its own license.

## OpenAI Codex — Apache-2.0

`infra/codex-remote/native.patch` is a patch against [openai/codex](https://github.com/openai/codex)
(Apache License 2.0). It is applied when building a custom `codex app-server`; see
`infra/codex-remote/native-build.md`. The patched files remain under the Apache License 2.0.

## Dependencies

npm dependencies (`bun.lock`) are installed at build time, not vendored. They are under
permissive licenses (MIT, ISC, Apache-2.0, BSD, 0BSD, Unlicense). Exceptions: `lightningcss`
(MPL-2.0, build tool), `caniuse-lite` (CC-BY-4.0, data), and the IBM Plex fonts
(`@fontsource/ibm-plex-*`, SIL OFL 1.1), which are bundled into the dashboard build.

The iOS app depends on [SwiftTerm](https://github.com/migueldeicaza/SwiftTerm) (MIT) through
Swift Package Manager.

## Software installed into the session image

`image/Dockerfile` downloads third-party tools when the image is built, including Claude Code
(`@anthropic-ai/claude-code`, proprietary — Anthropic's terms apply), OpenAI Codex CLI,
Grok Build, Bun, uv, Playwright and language servers. None of them are redistributed in this
repository. Do not publish a built `devbox` image without checking those licenses.
