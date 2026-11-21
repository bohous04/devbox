import Foundation
import os

/// Which view a tmux session opens on (Chat or Terminal), remembered per session on this device: the one the user
/// last switched to. The web keeps the same list in its localStorage (dashboard/src/tmuxTab.ts). A convenience of
/// this device: an unreadable list is logged and started over, the sessions opening on their defaults.
@MainActor
final class TmuxTabMemory {
    enum Tab: String, Codable { case chat, terminal }

    private struct Entry: Codable {
        let id: String
        let tab: Tab
    }

    static let maxEntries = 500
    static let key = "tmuxTabs"
    /// The app's list. A test host or a fixture run gets a scratch one, as MacAppState's windows do: the test host is
    /// the app itself, and its fixture session lists would prune (or fill) the user's real list.
    static let shared: TmuxTabMemory = {
        var scratch = ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil
        #if DEBUG
        scratch = scratch || FixtureMode.isActive
        #endif
        return TmuxTabMemory(defaults: scratch ? UserDefaults(suiteName: "DevboxTmuxTabs-scratch")! : .standard)
    }()
    private static let logger = Logger(subsystem: "com.example.devbox", category: "TmuxTabs")

    private let defaults: UserDefaults
    /// Oldest choice first.
    private var entries: [Entry]

    init(defaults: UserDefaults) {
        self.defaults = defaults
        guard let data = defaults.data(forKey: Self.key) else { entries = []; return }
        do {
            entries = try JSONDecoder().decode([Entry].self, from: data)
        } catch {
            Self.logger.error("remembered tmux tabs unreadable, starting over: \(String(describing: error), privacy: .public)")
            entries = []
        }
    }

    func tab(for sessionId: String) -> Tab? {
        entries.first { $0.id == sessionId }?.tab
    }

    /// The newest choice goes last; past the cap the least recently chosen goes.
    func remember(_ tab: Tab, for sessionId: String) {
        entries.removeAll { $0.id == sessionId }
        entries.append(Entry(id: sessionId, tab: tab))
        entries = Array(entries.suffix(Self.maxEntries))
        save()
    }

    /// Drops sessions devd no longer has (`live`: every session it lists). Written only when something went.
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
