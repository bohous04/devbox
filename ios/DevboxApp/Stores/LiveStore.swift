import Foundation

/// Live state of sessions/usage/cc-upkeep — mirrors the web (`dashboard/src/store.tsx` refresh and
/// `dashboard/src/pages/Sessions.tsx` loadUsage/loadCc): `/api/stats/live` and
/// `/api/stats/sessions` are polled every 5 s (first tick immediately, not after the first interval).
/// `/api/cc-upkeep` is fetched only once at start in the REGULAR polling (unlike the web, where the
/// Sessions page lives as long as the user is on it, the app does not need to re-poll it every 5 s) —
/// but `refreshNow()` (actions like Update/Switch agent) always re-polls it, see there.
///
/// `start()`/`stop()` control only whether polling runs, not screen visibility — pausing in the background
/// (scenePhase) is wired in the UI layer (Task 13); this store knows nothing about it.
@MainActor
final class LiveStore: ObservableObject {
    @Published private(set) var live: LiveStats?
    @Published private(set) var usage: [String: SessionUsage] = [:]
    @Published private(set) var cc: CcStatus?
    /// Last request error (live/usage tick). Previous data is NOT CLEARED on error — the UI should
    /// show an offline banner over it, not a stuck spinner or an empty screen. An error of
    /// the one-off `/api/cc-upkeep` deliberately does not go here (mirrors `loadCc()` on the web, which
    /// also just silently ignores failure — `cc` stays nil).
    @Published private(set) var lastError: String?

    private var client: DevdClient
    private let pollInterval: Duration
    private var pollTask: Task<Void, Never>?

    /// `pollInterval` has a production default of 5 s (like the web); tests can inject a shorter
    /// interval to verify polling without waiting a real 5 s.
    init(client: DevdClient, pollInterval: Duration = .seconds(5)) {
        self.client = client
        self.pollInterval = pollInterval
    }

    /// Rebuilds the store for a NEW client (different hostname/tailnet after Settings Save), WITHOUT discarding
    /// the `store` itself — `SessionsContainer` (DevboxAppApp.swift) calls this from
    /// `.onChange(of: appModel.clientIdentity)` instead of the earlier `.id(...)` on the whole container
    /// (review Critical, stage G task 30 fix): `.id(...)` tore down the WHOLE tree under `SessionsContainer`
    /// — tabs, navigation, and even the currently open `SettingsScreen` with its local state (Test
    /// connection result, Save error) — on EVERY config save. `stop()` → swap the client →
    /// discard old data (it belonged to the old server, not the new one) → `start()` fetches fresh
    /// data right away (the first tick in `start()`'s loop runs immediately, not after `pollInterval`).
    func rebuild(client: DevdClient) {
        stop()
        self.client = client
        live = nil
        usage = [:]
        cc = nil
        lastError = nil
        start()
    }

    /// Idempotent — a second call without `stop()` in between does not double the polling.
    func start() {
        guard pollTask == nil else { return }
        // `while let self` holds a strong reference only FOR ONE iteration, not for the whole
        // loop (unlike `guard let self else { return }` before the while) — otherwise the Task would
        // keep itself alive forever (via the captured `self`) and `deinit`/`stop()` would never break
        // the Task↔store reference cycle.
        pollTask = Task { [weak self] in
            while let self, !Task.isCancelled {
                await self.tick()
                if Task.isCancelled { return }
                try? await Task.sleep(for: self.pollInterval)
            }
        }
        // One-off, outside the polling loop — independent of `stop()` (it is just one request).
        Task { [weak self] in await self?.loadCcOnce() }
    }

    /// Idempotent — calling it without running polling is a no-op.
    func stop() {
        pollTask?.cancel()
        pollTask = nil
    }

    /// Forced immediate refresh of live/usage/cc outside the regular interval — called by actions
    /// (stop/restart/end/rename/switchAgent/ccUpkeepRun/…) in SessionsScreen/SessionDetailView, so
    /// the user sees the result right away, not after the rest of `pollInterval`. Unlike `start()` (where
    /// cc-upkeep is fetched only once) `refreshNow()` RE-POLLS cc — actions like Switch agent/Update
    /// change exactly the cc-upkeep state (panel version, stale flag) and the user is waiting for that result
    /// (see the "Claude Code" section of SessionDetailView).
    func refreshNow() async {
        async let liveTick: Void = tick()
        async let ccTick: Void = loadCcOnce()
        _ = await (liveTick, ccTick)
    }

    deinit {
        pollTask?.cancel()
    }

    // MARK: - Pure

    /// Mirrors the web (`Object.fromEntries(rows.map(r => [r.id, r]))`, see Sessions.tsx loadUsage)
    /// — for a duplicate id the last row wins.
    static func usageById(_ rows: [SessionUsage]) -> [String: SessionUsage] {
        Dictionary(rows.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
    }

    // MARK: - Private

    private func tick() async {
        async let liveResult: Result<LiveStats, Error> = fetchResult("/api/stats/live")
        async let usageResult: Result<[SessionUsage], Error> = fetchResult("/api/stats/sessions")
        let (l, u) = await (liveResult, usageResult)

        // Like the web (`Promise.allSettled`): a successful response overwrites its field, a failed one
        // keeps the last known data. An error from any request ends up in `lastError` —
        // EXCEPT cancellation (Task.cancel from `stop()`/deinit mid-flight): that is not "the app is
        // offline", just the end of polling, and the offline banner must not appear because of our own stop().
        var errorMessage: String?
        switch l {
        case .success(let value): live = value
        case .failure(let error) where !isCancellation(error): errorMessage = errorText(error)
        case .failure: break
        }
        switch u {
        case .success(let rows): usage = Self.usageById(rows)
        // If both fail, the `live` error is reported (see `errorMessage ?? ...` above) — the order is
        // arbitrary, just consistent.
        case .failure(let error) where !isCancellation(error): errorMessage = errorMessage ?? errorText(error)
        case .failure: break
        }
        lastError = errorMessage
    }

    /// `CancellationError` (structured concurrency) and `URLError(.cancelled)` (URLSession task
    /// cancelled together with its enclosing `Task`) — both mean "we killed the request ourselves",
    /// not a network/server error.
    private func isCancellation(_ error: Error) -> Bool {
        if error is CancellationError { return true }
        if let urlError = error as? URLError, urlError.code == .cancelled { return true }
        return false
    }

    private func loadCcOnce() async {
        cc = try? await client.get("/api/cc-upkeep")
    }

    private func fetchResult<T: Decodable>(_ path: String) async -> Result<T, Error> {
        do {
            return .success(try await client.get(path))
        } catch {
            return .failure(error)
        }
    }
}
