# File from the mac into the cc prompt — **⌘⇧V**

Get any file from the mac into Claude Code running in a devbox container.

## How to

1. In Finder, press **⌘C** on the file (normal copy).
2. Switch to **Warp** (to the session you want to work in).
3. Press **⌘⇧V** (cmd + shift + V).

→ The path `/inbox/<name>` appears in the prompt and cc reads the file right away.

> **Remember: files go via `⌘⇧V`, not `⌘V`.**
> `⌘V` is for clipboard images (screenshot → `[Image #N]`) and normal text.
> On a file, `⌘V` does Warp's plain paste (the path on the mac) — that does not get
> the file into cc in the container. Hence **file = `⌘⇧V`**.

## `⌘V` with an image works in all harnesses

`⌘V` with a screenshot sends `Ctrl+V` into the container. How the image gets into the
prompt differs by what runs in the session — this is decided by the tmux binding
(`image/devbox-ctrlv`) based on the processes on the tty:

- **Claude Code** (incl. the +GPT/+Grok/+OpenRouter profiles — all of them launch cc):
  the native path. cc reads the clipboard via the **xclip shim** and the image appears
  inline as `[Image #N]`.
- **Codex and Grok Build**: they do not call xclip — they read the clipboard via arboard
  (X11/Wayland directly), and there is no display server in the container, so `Ctrl+V` would
  fail silently. The binding therefore stages the image via devd into the shared `/inbox`
  (like `⌘⇧V` for files) and inserts the path `/inbox/img-<time>.png` into the prompt — both
  TUIs attach it the same way as when you drag a file into the terminal.
- **Shell / vim / anything else**: `Ctrl+V` passes through unchanged (literal-next,
  visual block).

A physical `Ctrl+V` in a codex/grok session also inserts text or a file from the mac clipboard
(same priorities as the xclip shim: file > image > text). An unavailable clipboard
(locked vault, sleeping mac) inserts a message into the prompt instead of failing silently.
>
> (Previously, `⌘V` on a file inserted a preview **icon** into cc: Finder attaches
> `com.apple.icns` to the clipboard, so the clipboard looks like an image. Fixed — `⌘V` now passes files
> through to Warp instead of sending the icon to cc.)

## What happens under the hood

`⌘⇧V` (Hammerspoon) → the file from the clipboard is uploaded to the **shared inbox** on the devbox
(`/srv/dev/_inbox`, which is mounted in every container as `/inbox`) → the path
`/inbox/<name>` is **typed into the prompt** (and also stays on the clipboard as a fallback for a manual
`⌘V`). The path is the same in every session, so it does not matter which session you are in.

> We **type the path character by character**; we do not send a synthetic `⌘V`: Warp has `⌘V` as its own
> keyboard shortcut and does not react to a synthetic event (`Ctrl+V` passes, `⌘V` does not),
> so the paste was silently lost and the prompt stayed empty.

## Prerequisites

- **A fresh session.** Only containers created after this feature was deployed get the `/inbox`
  mount. Older running sessions do not have it → a new session (`dev solo` / the dashboard
  "New session" button) gets it automatically; an old one needs to be recreated.
- **Hammerspoon** is running and has Accessibility (same as for the `⌘V` clipboard bridge).
- **SMB / devd** reachable (tailnet) — as with the rest of the devbox.

## Limits and tips

- **25 MB cap.** The file goes via devd (tailnet). A larger file → a message; drag it
  manually into the mounted SMB folder `/Volumes/dev/_inbox` (= the same `/inbox`).
- **No file on the clipboard** → `⌘⇧V` flashes the notification "No file on the clipboard — ⌘C in Finder".
- **Name collisions** in the inbox are resolved automatically (`-1`, `-2`, …).
- **Cleanup:** files stay in `/srv/dev/_inbox` (shared across sessions). Delete what you do not
  need from time to time.

## Where it lives

- Hotkey + script: `infra/hammerspoon-devbox.lua`, `infra/devbox-paste`.
- Server: `devd/src/api.ts` (`/api/clipboard/file?target=shared`,
  `/api/clipboard/image?target=shared`), `devd/src/inbox.ts` (`stageShared`),
  `devd/src/sessions.ts` (the `/inbox` mount).
- Container: `image/devbox-ctrlv` (tmux `C-v` binding, `image/tmux.conf`) — images
  for Codex/Grok Build; `image/xclip` (the shim for cc).
