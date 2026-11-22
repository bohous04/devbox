import Foundation
import os

/// Which view a tmux session opens on (Chat or Terminal), remembered per session on this device: the one the user
/// last switched to. The web keeps the same list in its localStorage (dashboard/src/tmuxTab.ts). A convenience of
/// this device: an unreadable list is logged and replaced by an empty one, the sessions opening on their defaults.
/// Observable, so an inbox row leads to the view chosen a moment ago (InboxRoute.row).
@MainActor
final class TmuxTabMemory: ObservableObject {
    enum Tab: String, Codable { case chat, terminal }

    private struct Entry: Codable {
        let id: String
        let tab: Tab
    }

    static let maxEntries = 500
    static let key = "tmuxTabs"
    /// The app's list. A test host or a fixture run gets a scratch one, emptied at start, as MacAppState's windows
    /// do: the test host is the app itself, and its fixture session lists would prune (or fill) the user's real list.
    static let shared: TmuxTabMemory = {
        var scratch = ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil
        #if DEBUG
        scratch = scratch || FixtureMode.isActive
        #endif
        guard scratch else { return TmuxTabMemory(defaults: .standard) }
        let suite = "DevboxTmuxTabs-scratch"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        return TmuxTabMemory(defaults: defaults)
    }()
    private static let logger = Logger(subsystem: "com.example.devbox", category: "TmuxTabs")

    private let defaults: UserDefaults
    /// Oldest choice first.
    @Published private var entries: [Entry]

    init(defaults: UserDefaults) {
        self.defaults = defaults
        guard let data = defaults.data(forKey: Self.key) else { entries = []; return }
        do {
            entries = try JSONDecoder().decode([Entry].self, from: data)
        } catch {
            Self.logger.error("remembered tmux tabs unreadable, starting over: \(String(describing: error), privacy: .public)")
            entries = []
            save()
        }
    }

    /// A session reopened under the same id is another session: it starts on its default, not the old one's tab.
    nonisolated static func key(_ sessionId: String, createdAt: Int) -> String { "\(sessionId)@\(createdAt)" }

    func tab(for key: String) -> Tab? {
        entries.first { $0.id == key }?.tab
    }

    /// The newest choice goes last; past the cap the least recently chosen goes.
    func remember(_ tab: Tab, for key: String) {
        var next = entries.filter { $0.id != key }
        next.append(Entry(id: key, tab: tab))
        entries = Array(next.suffix(Self.maxEntries))
        save()
    }

    /// Drops sessions devd no longer has (`live`: the `key` of every session it lists). Written only when something went.
    func prune(keeping live: Set<String>) {
        let kept = entries.filter { live.contains($0.id) }
        guard kept.count != entries.count else { return }
        entries = kept
        save()
    }

    private func save() {
        do {
            defaults.set(try JSONEncoder().encode(entries), forKey: Self.key)
        } catch {
            Self.logger.error("remembered tmux tabs not saved: \(String(describing: error), privacy: .public)")
        }
    }
}
