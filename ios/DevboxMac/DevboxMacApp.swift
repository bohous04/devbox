import SwiftUI

/// The Mac app: windows with the inbox as a sidebar and a thread (chat + terminal) as the detail, a menu bar extra
/// with the needs-you count, and Settings (connection, launch at login). Notifications come from the listener, whose
/// click opens `devbox://thread/<id>` here (S5-R9).
@main
struct DevboxMacApp: App {
    @NSApplicationDelegateAdaptor(MacAppDelegate.self) private var delegate

    var body: some Scene {
        // The value is the window's thread: opening a thread's value again focuses its window.
        WindowGroup("Devbox", id: MacWindow.sceneId, for: String.self) { $thread in
            MacWindow(thread: $thread)
                .environmentObject(delegate.state)
                .environmentObject(delegate.state.appModel)
        }
        // Links go to the delegate, which focuses or opens the thread's window, never a blank extra window.
        .handlesExternalEvents(matching: [])
        .defaultSize(width: 1100, height: 760)
        .commands { MacWindowCommands() }

        Settings {
            MacSettings()
                .environmentObject(delegate.state)
                .environmentObject(delegate.state.appModel)
        }

        MenuBarExtra {
            MenuBarMenu(state: delegate.state)
        } label: {
            MenuBarLabel(state: delegate.state)
        }
    }
}

/// ⌘N opens New session, ⌘⇧N a new window (the default ⌘N), ⌘F the sidebar's search, ⌘D switches the sidebar
/// between the sessions and the dashboard, ⌘⇧S settles the selected session and Undo Settle (⌘Z) takes it back while
/// the notice shows, all in the key window.
struct MacWindowCommands: Commands {
    @FocusedValue(\.macWindowActions) private var actions
    @FocusedValue(\.macSettle) private var settle
    @FocusedValue(\.macUndoSettle) private var undoSettle
    @Environment(\.openWindow) private var openWindow

    var body: some Commands {
        CommandGroup(replacing: .newItem) {
            Button("New Session") { actions?.newSession() }
                .keyboardShortcut("n")
                .disabled(actions == nil)
            Button("New Window") { openWindow(id: MacWindow.sceneId) }
                .keyboardShortcut("n", modifiers: [.command, .shift])
        }
        CommandGroup(after: .textEditing) {
            Button("Find Session…") { actions?.find() }
                .keyboardShortcut("f")
                .disabled(actions == nil)
        }
        CommandMenu("Session") {
            Button("Settle") { settle?.settle() }
                .keyboardShortcut("s", modifiers: [.command, .shift])
                .disabled(settle == nil || settle?.block != nil)
            // Listed for discovery and VoiceOver; the key itself is taken first by MacAppState's monitor, before Edit >
            // Undo's ⌘Z, in the same cases this item is enabled.
            Button("Undo Settle") { undoSettle?.undo() }
                .keyboardShortcut("z")
                .disabled(undoSettle == nil)
        }
        CommandGroup(after: .sidebar) {
            Button(actions?.inDashboard == true ? "Sessions" : "Dashboard") { actions?.toggleDashboard() }
                .keyboardShortcut("d")
                .disabled(actions == nil)
        }
    }
}
