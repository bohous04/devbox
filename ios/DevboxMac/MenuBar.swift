import SwiftUI

/// The menu bar icon with the number of sessions that need you.
struct MenuBarLabel: View {
    @ObservedObject var state: MacAppState
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        Group {
            if let inbox = state.inbox {
                NeedsYouLabel(inbox: inbox)
            } else {
                Image(systemName: "tray")
            }
        }
        // Always present, so `devbox://` links can open windows even when none is open.
        .onAppear { state.setOpenWindow(openWindow) }
    }
}

/// The count next to the icon; "?" marks it stale while the inbox stream is down or the list failed to load.
enum NeedsYouBadge {
    static func text(count: Int, stale: Bool) -> String? {
        switch (count, stale) {
        case (0, false): return nil
        case (0, true): return "?"
        case (_, false): return "\(count)"
        case (_, true): return "\(count)?"
        }
    }
}

private struct NeedsYouLabel: View {
    @ObservedObject var inbox: InboxStore

    var body: some View {
        let count = inbox.items.map(InboxView.needsYouCount) ?? 0
        let stale = inbox.paused || inbox.loadError != nil
        let icon = count > 0 ? "tray.full.fill" : "tray"
        if let text = NeedsYouBadge.text(count: count, stale: stale) {
            Label(text, systemImage: icon).labelStyle(.titleAndIcon)
                .accessibilityLabel("\(count) sessions need you\(stale ? ", updates paused" : "")")
        } else {
            Image(systemName: icon).accessibilityLabel("Nothing needs you")
        }
    }
}

/// The menu: what needs you (a click opens its window), then the app's windows, Settings and Quit.
struct MenuBarMenu: View {
    @ObservedObject var state: MacAppState
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        if let inbox = state.inbox {
            NeedsYouItems(inbox: inbox, open: state.openThread)
        } else {
            Text("Not connected")
        }
        Divider()
        Button("Open Devbox") {
            NSApp.activate(ignoringOtherApps: true)
            openWindow(id: MacWindow.sceneId)
        }
        SettingsLink { Text("Settings…") }
            .keyboardShortcut(",")
        Divider()
        Button("Quit Devbox") { NSApp.terminate(nil) }
            .keyboardShortcut("q")
    }
}

private struct NeedsYouItems: View {
    @ObservedObject var inbox: InboxStore
    let open: (String) -> Void

    var body: some View {
        if let items = inbox.items {
            let needsYou = InboxView.splitNeedsYou(InboxView.group(items).needsYou).action
            if needsYou.isEmpty {
                Text("Nothing needs you")
            } else {
                Section("Needs you") {
                    ForEach(needsYou) { item in
                        Button("\(item.title) — \(InboxView.reasonLabel(item.attention.reason))") { open(item.sessionId) }
                    }
                }
            }
        } else if let error = inbox.loadError {
            Text("Can't load the inbox: \(error)")
        } else {
            Text("Loading…")
        }
    }
}
