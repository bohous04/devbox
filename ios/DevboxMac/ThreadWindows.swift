import Foundation
import os

/// Which thread every open window shows, kept across quitting the app and restarting the Mac: the next launch reopens
/// those windows and each thread streams on from the seq it had (global constraint "Mac app restart"), with no user
/// action. macOS's own window restoration is not relied on: it is off when "Close windows when quitting an
/// application" is set and after a restart without "Reopen windows".
///
/// The window list is written on every change (a crash keeps it). A thread is written when the app quits or loses
/// focus and when a window closes or leaves it, so after a crash it comes from the last of those (an older seq only
/// means a longer catch-up: devd's replay sends everything changed after it). An ended session is forgotten.
@MainActor
final class ThreadWindows {
    private struct Window: Codable, Equatable {
        let id: String
        var threadId: String?
    }

    private static let logger = Logger(subsystem: "com.example.devbox", category: "Windows")
    private static let key = "openWindows"
    /// Where an unreadable window list is kept for a look instead of being overwritten.
    private static let unreadableKey = "openWindows.unreadable"
    private let defaults: UserDefaults
    private let directory: URL
    private var windows: [Window] = []
    /// The threads the last run had open, in window order; taken once by the first window (`restorePlan`).
    private var toRestore: [String]
    /// The app is quitting: its windows closing now must stay in the list.
    private var terminating = false
    private var stores: [String: ThreadStore] = [:]
    /// Ended threads' stores, kept only for the windows still showing them ("Session ended"); opening the thread
    /// again (`show`) builds a fresh store instead.
    private var endedStores: [String: ThreadStore] = [:]
    /// The last run's window list could not be read: said once in the app (logged too).
    let restoreProblem: String?

    init(defaults: UserDefaults, directory: URL) {
        self.defaults = defaults
        self.directory = directory
        var saved: [Window] = []
        var problem: String?
        if let data = defaults.data(forKey: Self.key) {
            do {
                saved = try JSONDecoder().decode([Window].self, from: data)
            } catch {
                Self.logger.error("saved window list unreadable, no windows restored: \(String(describing: error), privacy: .public)")
                defaults.set(data, forKey: Self.unreadableKey)
                problem = "The windows open at the last quit could not be read, so none were reopened (\(error.localizedDescription))."
            }
        }
        restoreProblem = problem
        var seen = Set<String>()
        toRestore = saved.compactMap(\.threadId).filter { seen.insert($0).inserted }
        persist()
        removeSavedThreads(except: Set(toRestore))
    }

    /// For the first window of a launch: the thread it should show itself (when it shows none) and the threads to
    /// open in windows of their own. Empty after the first call.
    func restorePlan(current: String?) -> (adopt: String?, open: [String]) {
        var rest = toRestore
        toRestore = []
        if let current {
            rest.removeAll { $0 == current }
            return (nil, rest)
        }
        guard !rest.isEmpty else { return (nil, []) }
        return (rest.removeFirst(), rest)
    }

    /// A window appeared or changed its thread.
    func show(window: String, thread: String?) {
        if let thread { endedStores[thread] = nil }
        if let i = windows.firstIndex(where: { $0.id == window }) {
            let old = windows[i].threadId
            windows[i].threadId = thread
            if let old, old != thread { dropIfUnshown(old) }
        } else {
            windows.append(Window(id: window, threadId: thread))
        }
        persist()
    }

    /// A window closed. While the app quits, its windows stay listed: they are what the next launch reopens.
    func close(window: String) {
        guard !terminating, let i = windows.firstIndex(where: { $0.id == window }) else { return }
        let old = windows.remove(at: i).threadId
        if let old { dropIfUnshown(old) }
        persist()
    }

    /// The thread's store, shared by the windows that show it. The first one after a launch starts from the saved
    /// thread, so it streams from that seq instead of loading the whole thread again.
    func store(for threadId: String, client: DevdClient, connect: ThreadStore.Connect? = nil) -> ThreadStore {
        if let s = stores[threadId] ?? endedStores[threadId] { return s }
        let s = ThreadStore(sessionId: threadId, client: client, restored: readSaved(threadId), connect: connect)
        stores[threadId] = s
        return s
    }

    /// The connection settings changed: stores of the old client go; windows build new ones.
    func dropStores() {
        for s in stores.values { s.stop() }
        stores = [:]
        endedStores = [:]
    }

    /// The app quits: keep the window list as it is and save the thread of every open window.
    func willTerminate() {
        terminating = true
        saveOpenThreads()
    }

    /// Saves the thread of every open window (quit, and when the app loses focus: a crash then loses little).
    func saveOpenThreads() {
        for id in stores.keys where windows.contains(where: { $0.threadId == id }) { save(id) }
    }

    /// devd says the thread's session is gone: no window restores it and its saved copy goes. Its store leaves the
    /// shared ones (reopening starts fresh) but stays with the windows still showing it, which keep saying it ended
    /// instead of loading it again.
    func ended(_ threadId: String) {
        for i in windows.indices where windows[i].threadId == threadId { windows[i].threadId = nil }
        persist()
        if let s = stores.removeValue(forKey: threadId) { endedStores[threadId] = s }
        remove(file(threadId))
    }

    // MARK: - Private

    private func dropIfUnshown(_ threadId: String) {
        guard !windows.contains(where: { $0.threadId == threadId }) else { return }
        save(threadId)
        stores.removeValue(forKey: threadId)?.stop()
    }

    private func save(_ threadId: String) {
        guard let thread = stores[threadId]?.thread else { return }
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try JSONEncoder().encode(thread).write(to: file(threadId), options: .atomic)
        } catch {
            Self.logger.error("could not save thread \(threadId, privacy: .public): \(String(describing: error), privacy: .public)")
        }
    }

    private func persist() {
        do {
            defaults.set(try JSONEncoder().encode(windows), forKey: Self.key)
        } catch {
            Self.logger.error("could not save the window list: \(String(describing: error), privacy: .public)")
        }
    }

    /// The saved thread, nil when there is none; an unreadable one is logged and the thread loads whole.
    private func readSaved(_ threadId: String) -> ThreadSnapshot? {
        let url = file(threadId)
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        do {
            return try JSONDecoder().decode(ThreadSnapshot.self, from: Data(contentsOf: url))
        } catch {
            Self.logger.error("saved thread \(threadId, privacy: .public) unreadable, loading it whole: \(String(describing: error), privacy: .public)")
            return nil
        }
    }

    private func removeSavedThreads(except keep: Set<String>) {
        guard FileManager.default.fileExists(atPath: directory.path) else { return }
        let keepNames = Set(keep.map { file($0).lastPathComponent })
        do {
            for f in try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
            where !keepNames.contains(f.lastPathComponent) {
                remove(f)
            }
        } catch {
            Self.logger.error("could not list saved threads: \(String(describing: error), privacy: .public)")
        }
    }

    private func remove(_ url: URL) {
        do {
            try FileManager.default.removeItem(at: url)
        } catch CocoaError.fileNoSuchFile {
        } catch {
            Self.logger.error("could not remove \(url.lastPathComponent, privacy: .public): \(String(describing: error), privacy: .public)")
        }
    }

    private func file(_ threadId: String) -> URL {
        directory.appendingPathComponent(pathSegment(threadId)).appendingPathExtension("json")
    }
}
