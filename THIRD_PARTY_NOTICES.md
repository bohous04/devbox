# Third-party notices

devbox is licensed under the Apache License 2.0 ([LICENSE](LICENSE)). It includes or modifies the
following third-party code, which keeps its own license.

## OpenAI Codex — Apache-2.0

`infra/codex-remote/native.patch` is a patch against [openai/codex](https://github.com/openai/codex)
(Apache License 2.0). It is applied when building a custom `codex app-server`; see
`infra/codex-remote/native-build.md`. The patched files remain under the Apache License 2.0.

## LobeHub Icons — MIT

The agents' marks (`dashboard/src/components/agentLogos.tsx`, `ios/DevboxApp/Assets.xcassets/AgentLogos`) are SVG
paths copied from [LobeHub Icons](https://github.com/lobehub/lobe-icons), npm `@lobehub/icons-static-svg@1.102.0`
(mono variants `claude`, `openai`, `grok`, `antigravity`, `mistral`). The marks themselves are trademarks of Anthropic,
OpenAI, xAI, Google and Mistral AI; they mark which agent runs a session and imply no endorsement. The ring shown for
an agent the client does not know is devbox's own.

```
MIT License

Copyright (c) 2023 LobeHub

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

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
