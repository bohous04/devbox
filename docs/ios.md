# iOS app

The app in `ios/` shows your sessions, opens chat sessions as threads, lets you answer SSH and production-write approvals,
unlock the vault, and keeps a Live Activity with what is waiting for you. It is not in the
App Store — you build it yourself with your own Apple developer account.

## Build

```bash
brew install xcodegen
cd ios && xcodegen generate
open DevboxApp.xcodeproj
```

Before the first build, change these placeholders in `ios/project.yml` (then run
`xcodegen generate` again):

| What | Where | Placeholder |
|---|---|---|
| Bundle IDs | `bundleIdPrefix`, both `PRODUCT_BUNDLE_IDENTIFIER` | `com.example.devbox`, `com.example.devbox.live-activity` |
| Signing team | both `DEVELOPMENT_TEAM` | empty |
| App Group (shared with the widget) | `ios/DevboxApp/DevboxApp.entitlements`, `ios/DevboxLiveActivity/DevboxLiveActivity.entitlements` | `group.com.example.devbox` |
| devd's tailnet IP | `NSAppTransportSecurity` → `NSExceptionDomains` | `100.64.0.10` |

The last one matters: over the tailnet the app talks plain HTTP to devd's IP, and iOS only
allows that for the IP listed there. With the placeholder left in, every request over the
tailnet fails. Behind Cloudflare Access (HTTPS) no exception is needed.

## Chat sessions

Sessions that run in the chat runtime ([Runtimes](../README.md#runtimes)) open as a thread:
messages, tool calls, images, questions you answer in place and a queue for follow-ups.
The Inbox lists what is waiting, working or done across sessions. Creating a session without
picking a runtime follows the server's *Default runtime* setting, and the app shows the
server's notice when it had to use the other runtime. Terminal (tmux) sessions are still listed, with the existing approvals and Live
Activity.

## Connect

In the app's **Settings**, fill in either the tailnet URL (`http://<devd-tailnet-ip>:4300`)
or the Cloudflare Access hostname with a service token (client ID and secret), then
**Test connection**.

## Push notifications and Live Activities

devd sends them through APNs. Create an APNs auth key (`.p8`) in your developer account, put
it on the server, and add to `settings` in `/etc/devd/config.json`:

```json
"apns": {
  "keyPath": "/etc/devd/apns/AuthKey_XXXXXXXXXX.p8",
  "keyId": "XXXXXXXXXX",
  "teamId": "YOURTEAMID",
  "bundleId": "com.yourname.devbox",
  "sandbox": true
},
"phoneChannel": "apns"
```

`sandbox: true` for builds installed from Xcode, `false` for TestFlight and release builds.

## Trying the Live Activity without a server

A Debug build launched with the argument `--live-activity-preview` shows a screen that starts
sample Live Activities (waiting, working, stalled, stale) — handy for checking the Lock Screen
and the Dynamic Island in the simulator.
