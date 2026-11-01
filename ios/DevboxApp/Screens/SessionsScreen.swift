import SwiftUI

/// Session list — behavior mirrors `dashboard/src/pages/Sessions.tsx` (`SessionRow` + sorting),
/// except that instead of an inline accordion (web) a row opens `SessionDetailView` as a push in the
/// `NavigationStack` — on mobile that is more natural than an expanding card.
struct SessionsScreen: View {
    @EnvironmentObject private var store: LiveStore
    @EnvironmentObject private var appModel: AppModel
    let actions: SessionActions

    @State private var showNewSession = false

    var body: some View {
        Group {
            if let live = store.live {
                listContent(live)
            } else if let lastError = store.lastError {
                // `live` has never arrived yet (the first tick after startup failed) — a spinner forever would
                // look like a frozen app; better to show right away what is going on.
                ContentUnavailableView(
                    "Can't reach devd",
                    systemImage: "wifi.slash",
                    description: Text(lastError)
                )
            } else {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.C.background)
        .navigationTitle("Sessions")
        .navigationDestination(for: String.self) { sessionId in
            SessionDetailView(sessionId: sessionId, actions: actions)
        }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button("New session") { showNewSession = true }
            }
        }
        .sheet(isPresented: $showNewSession) {
            NewSessionSheet(actions: actions) { await store.refreshNow() }
                .environmentObject(store)
        }
    }

    @ViewBuilder
    private func listContent(_ live: LiveStats) -> some View {
        let sessions = Self.sorted(live.sessions)
        let running = sessions.filter { $0.status == .running }.count
        ScreenScroll {
            // `live` is the last KNOWN data (LiveStore does not clear it on error) — the error above it is
            // therefore a banner above the list, not a replacement of the screen (that belongs only to the first failure, see
            // above).
            if let lastError = store.lastError {
                if !appModel.isOnline || lastError == offlineErrorText {
                    OfflineBanner()
                } else {
                    OfflineBanner(message: lastError)
                }
            }
            VStack(alignment: .leading, spacing: 8) {
                SectionHeader("Sessions", trailing: sessions.isEmpty ? nil : "\(running) running")
                if sessions.isEmpty {
                    EmptyState(
                        "No sessions — start one with the dev command, or tap New session above.",
                        systemImage: "terminal"
                    )
                } else {
                    ForEach(sessions, id: \.id) { session in
                        NavigationLink(value: session.id) {
                            SessionRow(session: session, cc: ccStatus(for: session.id), latest: store.cc?.latest)
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("session-row")
                    }
                }
            }
        }
        .refreshable { await store.refreshNow() }
    }

    private func ccStatus(for id: String) -> CcSessionStatus? {
        store.cc?.sessions.first { $0.id == id }
    }

    // MARK: - Pure

    private static let stateOrder: [ClaudeState: Int] = [.working: 0, .waiting: 1, .idle: 2]

    /// Mirrors `sortSessions` from the web: running sessions first; within running ones by claudeState
    /// (working → waiting → idle), otherwise by last activity descending.
    static func sorted(_ sessions: [SessionLive]) -> [SessionLive] {
        sessions.sorted { a, b in
            let runA = a.status == .running ? 0 : 1
            let runB = b.status == .running ? 0 : 1
            if runA != runB { return runA < runB }
            if a.status == .running {
                let sa = stateOrder[a.claudeState] ?? 3
                let sb = stateOrder[b.claudeState] ?? 3
                if sa != sb { return sa < sb }
            }
            return a.last_active_at > b.last_active_at
        }
    }
}

/// Dot tone by state — mirrors `DOT` from primitives.tsx (`working` emerald, `waiting` amber,
/// `idle`/`stopped` zinc-400); only `working` pulses, same as the web.
private func statusTone(_ session: SessionLive) -> StatusTone {
    guard session.status == .running else { return .idle }
    switch session.claudeState {
    case .working: return .ok
    case .waiting: return .warn
    case .idle, .unknown: return .idle
    }
}

/// Version `a` is older than `b` (dotted major.minor.patch) — mirrors `isOlder` from
/// `dashboard/src/ccUpkeepView.ts`.
private func isOlderVersion(_ a: String, _ b: String) -> Bool {
    let x = a.split(separator: ".").map { Int($0) ?? 0 }
    let y = b.split(separator: ".").map { Int($0) ?? 0 }
    for i in 0..<3 {
        let p = i < x.count ? x[i] : 0
        let q = i < y.count ? y[i] : 0
        if p < q { return true }
        if p > q { return false }
    }
    return false
}

/// Mirrors `rowState` from `ccUpkeepView.ts`, narrowed to what the badge needs to know: it is only
/// a binary "outdated or not" (unlike the web, the app does not distinguish "unknown").
private func isCcOutdated(_ status: CcSessionStatus?, latest: String?) -> Bool {
    guard let status, let version = status.version, let stale = status.stalePanes else { return false }
    if stale > 0 { return true }
    if let latest, isOlderVersion(version, latest) { return true }
    return false
}

/// Card of one session — port of the web `SessionRow` (collapsed state): dot, name (+ star
/// for important, shield for critic), below it "project · agent · account", on the right state and the
/// "CC update" badge when Claude Code is outdated. A tap opens `SessionDetailView` (the web expands
/// the card in place; on a phone a push is more natural).
private struct SessionRow: View {
    let session: SessionLive
    let cc: CcSessionStatus?
    let latest: String?

    private var displayName: String {
        let nick = session.name?.trimmingCharacters(in: .whitespacesAndNewlines)
        return (nick?.isEmpty == false ? nick : nil) ?? session.repo
    }

    private var metaLine: String {
        var line = "\(session.project) · \(AgentProfiles.profile(for: session.agent).short)"
        if let accountId = session.accountId { line += " · \(accountId)" }
        return line
    }

    private var stateText: String {
        session.status == .running ? Format.stateLabel(session.claudeState).capitalized : "Stopped"
    }

    var body: some View {
        Card {
            HStack(spacing: 12) {
                StatusDot(statusTone(session), pulse: session.status == .running && session.claudeState == .working)

                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 6) {
                        Text(displayName)
                            .font(Theme.F.body.weight(.semibold))
                            .foregroundStyle(Theme.C.foreground)
                            .lineLimit(1)
                        if session.important == 1 {
                            Image(systemName: "star")
                                .font(.system(size: 11))
                                .foregroundStyle(Theme.C.mutedForeground)
                                .accessibilityLabel("Important")
                        }
                        if (session.critic ?? 0) == 1 {
                            Image(systemName: "checkmark.shield")
                                .font(.system(size: 11))
                                .foregroundStyle(Theme.C.mutedForeground)
                                .accessibilityLabel("Critic enabled")
                        }
                    }
                    Text(metaLine)
                        .font(Theme.F.meta)
                        .foregroundStyle(Theme.C.mutedForeground)
                        .lineLimit(1)
                }

                Spacer(minLength: 8)

                VStack(alignment: .trailing, spacing: 4) {
                    Text(stateText)
                        .font(Theme.F.meta)
                        .foregroundStyle(Theme.C.mutedForeground)
                    if isCcOutdated(cc, latest: latest) {
                        Badge("CC update", variant: .outline)
                    }
                }

                Image(systemName: "chevron.right")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Theme.C.mutedForeground)
            }
        }
        .contentShape(Rectangle())
    }
}
