# Windows, Linux and browser clients

A computer with Tailscale and a browser can use the dashboard without the Mac listener.
Use a current Chrome, Edge, Firefox or Safari; the terminal controls work with a mouse,
keyboard or file picker. The `dev` CLI over SSH remains optional.

## Text, images and files

Open a session terminal and click **Take control**. You can:

- select text locally (hold **Shift** while dragging if the application captures the mouse),
  then click **Copy selection**, or use your browser's Copy command;
- click **Paste**, or press **Ctrl+V** on Windows/Linux and **Cmd+V** on macOS;
- paste a screenshot or files copied in Explorer/Finder into the terminal;
- drop one or more files on the terminal, or click **Upload files**.

The browser uploads binary files directly to devd and pastes their sanitized `/inbox/<name>`
paths into the active prompt. Claude Code, Codex and Grok can read the attached paths.
Uploads use the existing shared inbox, just like the Mac's file/image hotkey: every session
can read these files. Names get a suffix on collisions; files remain until you delete them.

There is a **25 MB limit per file** and a maximum of 20 files per action. Upload requests
are accepted only from operator addresses (loopback, the tailnet or `DEVD_APPROVAL_ALLOW`)
and from allowed dashboard origins. Guest links do not offer file uploads. Uploads work
with a locked vault and without a desktop listener. The inbox currently lives on the VPS;
InstaBox sessions report that uploads are unavailable.

**Plain HTTP on the tailnet:** keyboard paste, file paste, drag/drop and the file picker
work without HTTPS. Browsers restrict programmatic clipboard reads on HTTP. In that case,
**Paste** opens a box: paste into it with the keyboard, then click **Insert** for text;
images/files upload immediately. **Copy selection** and **Copy** also try the browser's
legacy copy action when the secure-context Clipboard API is unavailable. If the browser
blocks that too, select text and use its native Copy command. See the browser's
[clipboard security requirements](https://developer.mozilla.org/en-US/docs/Web/API/Clipboard_API).

## Copy actions inside the session

The session's copy action (including tmux copy-mode and a CLI's "c to copy") reaches the
web terminal through **OSC 52**. The dashboard shows the text with **Copy** and **Dismiss**.
Click **Copy** to put it on your computer's clipboard. Session output never silently
replaces your clipboard, and clipboard-read queries are never answered.

The image enables `set-clipboard on`. An existing session can pick up just this option
without being recreated:

```sh
docker exec -u dev <session-container> tmux set-option -g set-clipboard on
```

This changes the tmux server in that container; rebuild the image for new sessions.

## Sign in without a Mac

In **AI limits → Service connections**, choose **Claude → Sign in with Claude**. Open the
sign-in link in your local browser, finish authorization and paste Claude's code into the
dialog. **Sign in again** replaces the shared default sign-in. Existing agent processes
pick it up when they next start. Additional accounts in the automatic account pool are
managed separately; see [account-pool.md](account-pool.md).

The helper runs on the VPS using the same `claude-home` volume as sessions. Only operator
addresses can start, submit or inspect the login. OAuth codes go to stdin, not shell
arguments or logs. Codex, Grok and Antigravity have their own login controls on the same page.

## Platform-specific integrations

| Workflow | Mac desktop integration | Windows/Linux browser |
|---|---|---|
| Terminal and session management | `dev` CLI, Warp or dashboard | dashboard, or SSH from Windows Terminal |
| Text copy/paste | desktop clipboard | **Copy selection**, **Copy**, **Paste**, keyboard shortcuts |
| Images and files | listener + Mac hotkeys | screenshot/file paste, drop, **Upload files** |
| Claude login | CLI or dashboard | dashboard login, or CLI over SSH |
| SSH/DB approvals | native dialog, dashboard or iOS | dashboard approval pages |
| Session activity | native notifications and Warp badges | dashboard Overview and session state |
| Finder mount / Warp recovery | macOS-specific integrations | optional SMB share in Explorer; SSH or dashboard |

The browser does not install a native Windows notification service or replace terminal
applications outside the dashboard. The optional Mac listener remains available for
Mac desktop workflows; it is not a dependency of browser copy/paste or uploads.
