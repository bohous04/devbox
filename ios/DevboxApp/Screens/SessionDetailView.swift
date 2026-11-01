import SwiftUI

/// Detail of one session — actions mirror `dashboard/src/pages/Sessions.tsx` (`SessionRow` when
/// expanded), Terminal additionally `dashboard/src/components/Terminal.tsx` (see `TerminalScreen`).
struct SessionDetailView: View {
    @EnvironmentObject private var store: LiveStore
    // Only for `client` for `TerminalScreen` — read in a plain Button closure (`body`
    // context), not in the toolbar. Lesson from Task 15 (P0 crash): an `@EnvironmentObject` read from
    // a UIKit-bridged toolbar action leading to `.fullScreenCover` did not get the environment; so `client`
    // goes into `TerminalScreen` via init (constructor injection), not via `.environmentObject` on
    // the cover's content — `appModel` itself is read only here, in a regular Button context.
    @EnvironmentObject private var appModel: AppModel
    @Environment(\.dismiss) private var dismiss
    let sessionId: String
    let actions: SessionActions

    @State private var busy = false
    @State private var errorMessage: String?

    @State private var isRenaming = false
    @State private var nameDraft = ""

    @State private var agentPick: AgentName?
    @State private var showEndConfirm = false
    @State private var showSwitchAccountConfirm = false
    @State private var showSwitchAgentConfirm = false
    @State private var showTerminal = false

    @State private var reviews: [CriticReview] = []
    @State private var showFindings = false

    @State private var showShareSheet = false
    @State private var shares: [ActiveShare] = []
    @State private var sharesVersion = 0
    @State private var revokeShareId: String?
    @State private var showRecreateConfirm = false

    private var session: SessionLive? {
        store.live?.sessions.first { $0.id == sessionId }
    }

    var body: some View {
        Group {
            if let session {
                detail(for: session)
            } else {
                ContentUnavailableView(
                    "Session no longer exists",
                    systemImage: "questionmark.folder",
                    description: Text("It may have been ended from another device.")
                )
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.C.background)
        .navigationTitle(session.map(displayTitle) ?? "Session")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear(perform: consumeDeepLinkIfNeeded)
        .onChange(of: appModel.pendingDeepLink) { _, _ in consumeDeepLinkIfNeeded() }
    }

    @ViewBuilder
    private func detail(for session: SessionLive) -> some View {
        let usage = store.usage[session.id]
        let running = session.status == .running
        // .unknown (tolerant decoding fallback — unknown agent from a newer devd) and nil are
        // normalized to .claude in one place (AgentProfiles.normalize), same as the web
        // (agentNameFor) — otherwise the Picker would have no row selected.
        let currentAgent = AgentProfiles.normalize(session.agent)
        let targetAgent = agentPick ?? currentAgent

        ScreenScroll {
            // Header like the expanded web card: project/repo, folder · solo · state, Rename.
            Card {
                VStack(alignment: .leading, spacing: 12) {
                    HStack(alignment: .top, spacing: 8) {
                        VStack(alignment: .leading, spacing: 4) {
                            Label {
                                Text("\(session.project)/\(session.repo)")
                                    .font(Theme.F.body.weight(.medium))
                            } icon: {
                                Image(systemName: "folder").foregroundStyle(Theme.C.mutedForeground)
                            }
                            Text(metadataLine(session))
                                .font(Theme.F.meta)
                                .foregroundStyle(Theme.C.mutedForeground)
                        }
                        Spacer(minLength: 4)
                        Button {
                            nameDraft = session.name ?? ""
                            isRenaming = true
                        } label: {
                            Label("Rename", systemImage: "pencil")
                        }
                        .buttonStyle(DevboxButtonStyle(variant: .ghost))
                        .disabled(busy)
                    }
                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        StatGrid(statItems(session: session, usage: usage, now: context.date, running: running))
                    }
                }
            }

            VStack(alignment: .leading, spacing: 8) {
                SectionHeader("Actions")
                LazyVGrid(columns: actionColumns, spacing: 8) {
                    if running {
                        actionButton("Terminal", systemImage: "terminal", variant: .default) { showTerminal = true }
                            .disabled(appModel.client == nil)
                    }

                    // Hidden for InstaBox — the server would reject `POST …/shares` on it with 409 (see
                    // `ibxOnly` in devd/src/api.ts), same as `s.host !== "instabox"` on the web.
                    // A missing `host` (older devd) behaves as "vps" — the action stays visible.
                    if running, (session.host ?? .vps) != .instabox {
                        actionButton("Share", systemImage: "square.and.arrow.up", variant: .outline) { showShareSheet = true }
                            .disabled(busy || appModel.client == nil)
                    }

                    actionButton(session.important == 1 ? "Important ✓" : "Mark important", systemImage: "star", variant: .outline) {
                        run { try await actions.setImportant(session.id, session.important != 1) }
                    }
                    .disabled(busy)

                    actionButton((session.critic ?? 0) == 1 ? "Critic ✓" : "Enable critic", systemImage: "checkmark.shield", variant: .outline) {
                        run { try await actions.setCritic(session.id, (session.critic ?? 0) != 1) }
                    }
                    .disabled(busy)

                    if running {
                        actionButton("Stop", systemImage: "stop", variant: .outline) { run { try await actions.stop(session.id) } }
                            .disabled(busy)
                    } else if session.solo == 1 {
                        actionButton("Restart", systemImage: "arrow.clockwise", variant: .outline) { run { try await actions.restart(session.id) } }
                            .disabled(busy)
                    }

                    // Without accountId there is nothing to switch to — an old container without profile mounts (or
                    // a stopped session whose leases stop() released). See the same note on the web.
                    if session.accountId != nil {
                        actionButton("Switch account…", systemImage: "person.2", variant: .outline) { showSwitchAccountConfirm = true }
                            .disabled(busy)
                    }

                    actionButton(session.solo == 1 ? "Delete workspace…" : "End…", systemImage: "xmark.circle", variant: .destructive) {
                        showEndConfirm = true
                    }
                    .disabled(busy)
                }
            }

            // Live agent (harness) swap — devd restarts the panes onto the new profile in place
            // (without recreating the container): claude→claude* keeps the conversation via --resume, switching to
            // a different CLI loses it. Only for a running session (same as on the web).
            if running {
                VStack(alignment: .leading, spacing: 8) {
                    SectionHeader("Agent")
                    Card {
                        VStack(spacing: 10) {
                            // `Menu` with an embedded `Picker` instead of a bare `Picker` — outside a `Form` a
                            // `.menu` Picker would show only the selected value without the "Agent" label.
                            Menu {
                                Picker("Agent", selection: Binding(
                                    get: { targetAgent },
                                    set: { agentPick = $0 }
                                )) {
                                    ForEach(AgentProfiles.ids, id: \.self) { id in
                                        Text(AgentProfiles.profile(for: id).label).tag(id)
                                    }
                                }
                            } label: {
                                HStack {
                                    Text("Agent").foregroundStyle(Theme.C.foreground)
                                    Spacer()
                                    Text(AgentProfiles.profile(for: targetAgent).label)
                                        .foregroundStyle(Theme.C.mutedForeground)
                                    Image(systemName: "chevron.up.chevron.down")
                                        .font(.system(size: 10))
                                        .foregroundStyle(Theme.C.mutedForeground)
                                }
                                .font(Theme.F.body)
                                .frame(minHeight: 44)
                            }
                            // Exactly "Agent, <name>" (like the former Form Picker) — `LiveE2ETests` relies
                            // on that label; a chevron icon would add a nondeterministic symbol name
                            // to the combined label.
                            .accessibilityElement(children: .ignore)
                            .accessibilityLabel("Agent, \(AgentProfiles.profile(for: targetAgent).label)")
                            .accessibilityAddTraits(.isButton)
                            actionButton("Switch agent…", systemImage: "arrow.triangle.2.circlepath", variant: .outline) { showSwitchAgentConfirm = true }
                                .disabled(busy || targetAgent == currentAgent)
                        }
                    }
                }
            }

            // Shown only when LiveStore.cc has a record for this session (mirrors web ccById
            // lookup in Sessions.tsx `SessionRow`) — after an action (Update/Switch agent) `run()` calls
            // `store.refreshNow()`, which re-polls cc-upkeep (see LiveStore.refreshNow), so the
            // "outdated" badge disappears right after the action finishes, not only after an app restart.
            if let cc = store.cc?.sessions.first(where: { $0.id == session.id }) {
                VStack(alignment: .leading, spacing: 8) {
                    SectionHeader("Claude Code")
                    Card {
                        // `lineLimit(1)` + `minimumScaleFactor` — with large Dynamic Type the side-by-side
                        // items otherwise wrapped into ugly narrow columns (layout QA report).
                        HStack(spacing: 8) {
                            Text(cc.version ?? "?")
                                .font(.system(size: 14, design: .monospaced))
                                .lineLimit(1)
                                .minimumScaleFactor(0.7)
                            if isCcOutdated(cc, latest: store.cc?.latest) {
                                Badge("outdated", variant: .destructive)
                            }
                            Spacer()
                            Button {
                                run { try await actions.ccUpkeepRun(session.id) }
                            } label: {
                                Text("Update").lineLimit(1).minimumScaleFactor(0.7)
                            }
                            .buttonStyle(DevboxButtonStyle(variant: .outline))
                            .disabled(busy)
                        }
                    }
                }
            }

            if (session.critic ?? 0) == 1, let badge = criticBadge(reviews.first) {
                VStack(alignment: .leading, spacing: 8) {
                    SectionHeader("Critic")
                    Card {
                        VStack(alignment: .leading, spacing: 8) {
                            Button {
                                showFindings.toggle()
                            } label: {
                                Text(badge.text)
                                    .font(Theme.F.meta.weight(.semibold))
                                    .foregroundStyle(badge.tone)
                            }
                            if showFindings, let latest = reviews.first {
                                ForEach(Array(findingLines(latest).enumerated()), id: \.offset) { _, line in
                                    Text(line).font(Theme.F.meta)
                                }
                                if let evidence = latest.evidence {
                                    Text(evidence)
                                        .font(.system(size: 11, design: .monospaced))
                                        .foregroundStyle(Theme.C.mutedForeground)
                                }
                            }
                        }
                    }
                }
            }

            let sessionShares = ShareView.activeShares(shares, sessionId: session.id)
            if ShareView.showsTaint(session: session, activeShares: sessionShares) {
                VStack(alignment: .leading, spacing: 8) {
                    SectionHeader("Sharing")
                    Card {
                        VStack(alignment: .leading, spacing: 8) {
                            Label {
                                Text(ShareView.taintMessage)
                                    .font(Theme.F.body)
                            } icon: {
                                Image(systemName: "exclamationmark.triangle.fill")
                                    .foregroundStyle(Theme.C.warn)
                            }
                            Button(ShareView.taintAction) { showRecreateConfirm = true }
                                .buttonStyle(DevboxButtonStyle(variant: .outline))
                                .disabled(busy || appModel.client == nil)
                        }
                        .padding(.vertical, 8)
                    }
                }
            }
            if !sessionShares.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    SectionHeader("Active shares", trailing: "\(sessionShares.count)")
                    Card {
                        VStack(alignment: .leading, spacing: 0) {
                            ForEach(Array(sessionShares.enumerated()), id: \.element.id) { index, share in
                                if index > 0 { Divider() }
                                HStack(spacing: 8) {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(shareLabel(share, session: session))
                                            .font(Theme.F.body.weight(.medium))
                                        Text("Valid until \(ShareView.expiryLabel(Double(share.expires_at)))")
                                            .font(Theme.F.meta)
                                            .foregroundStyle(Theme.C.mutedForeground)
                                    }
                                    Spacer(minLength: 8)
                                    Button("Revoke") { revokeShareId = share.id }
                                        .buttonStyle(DevboxButtonStyle(variant: .outline))
                                        .disabled(busy)
                                }
                                .padding(.vertical, 8)
                            }
                        }
                    }
                }
            }

            if let errorMessage {
                Text("Error: \(errorMessage)")
                    .font(Theme.F.meta)
                    .foregroundStyle(Theme.C.dangerText)
            }
        }
        .alert("Rename", isPresented: $isRenaming) {
            TextField("nickname (empty = clear)", text: $nameDraft)
            Button("Save") {
                run { try await actions.setName(session.id, nameDraft.trimmingCharacters(in: .whitespacesAndNewlines)) }
            }
            Button("Cancel", role: .cancel) {}
        }
        // Confirmation dialogs hang at the `ScreenScroll` level, not on the buttons inside
        // `LazyVGrid`/`LazyVStack` — a lazy container may discard an off-screen cell and a dialog
        // attached to it would close or never show up.
        .confirmationDialog(
            "Restart panels onto \(session.accountId ?? "")?",
            isPresented: $showSwitchAccountConfirm, titleVisibility: .visible
        ) {
            Button("Restart panels?", role: .destructive) {
                run {
                    let r = try await actions.switchAccount(session.id)
                    if !r.ok {
                        if let rid = r.accountId {
                            throw DevdClientError(description: "Couldn't restart any panel onto \(r.label ?? rid) — check the container.")
                        }
                        throw DevdClientError(description: "No account available for this session.")
                    }
                }
            }
            Button("Cancel", role: .cancel) {}
        }
        .confirmationDialog(
            session.solo == 1 ? "Delete workspace" : "End session",
            isPresented: $showEndConfirm, titleVisibility: .visible
        ) {
            Button(session.solo == 1 ? "Delete workspace" : "Yes, end it", role: .destructive) {
                run {
                    try await actions.end(session.id, soloAction: session.solo == 1 ? .delete : nil)
                    dismiss()
                }
            }
            Button("Cancel", role: .cancel) {}
        }
        .confirmationDialog(
            "Restart onto it?", isPresented: $showSwitchAgentConfirm, titleVisibility: .visible
        ) {
            Button("Restart onto it?", role: .destructive) {
                run {
                    let r = try await actions.switchAgent(session.id, targetAgent)
                    if let msg = SessionActions.agentSwitchError(r, label: AgentProfiles.profile(for: targetAgent).label) {
                        throw DevdClientError(description: msg)
                    }
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Restarts the agent in every window — an in-flight turn is lost; switching to a different CLI drops the conversation")
        }
        // The confirmation holds only `revokeShareId` — a binding instead of its own `@State Bool` (the same trick
        // would work for the other dialogs above, but here we need to know WHICH share to revoke).
        .confirmationDialog(
            "Revoke this share?",
            isPresented: Binding(get: { revokeShareId != nil }, set: { if !$0 { revokeShareId = nil } }),
            titleVisibility: .visible
        ) {
            Button("Revoke", role: .destructive) {
                let id = revokeShareId
                revokeShareId = nil
                guard let id else { return }
                run {
                    guard let client = appModel.client else { return }
                    try await client.revokeShare(id)
                    shares.removeAll { $0.id == id }
                }
            }
            Button("Cancel", role: .cancel) {}
        }
        .task(id: "\(session.id)-\(session.critic ?? 0)-\(session.last_active_at)") {
            await loadReviewsIfNeeded(session: session)
        }
        .confirmationDialog(
            "\(ShareView.taintAction)?",
            isPresented: $showRecreateConfirm, titleVisibility: .visible
        ) {
            Button(ShareView.taintAction, role: .destructive) {
                guard let client = appModel.client else { return }
                run { try await client.recreateSession(session.id) }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("The container is rebuilt (unfinished work in /workspace is kept) — this lifts the post-sharing restriction.")
        }
        .task(id: "\(session.id)-shares-\(sharesVersion)") {
            await loadShares(session: session)
        }
        .sheet(isPresented: $showShareSheet) {
            if let client = appModel.client {
                ShareSessionSheet(client: client, sessionId: session.id) {
                    sharesVersion += 1
                }
            } else {
                // Same race as with the terminal `fullScreenCover` above — the button is disabled when
                // `client` is missing, but the app may have disconnected between the tap and presenting the sheet.
                VStack(spacing: 16) {
                    Text("Lost connection to the devbox.")
                        .font(.headline)
                    Button("Close") { showShareSheet = false }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Theme.C.background)
            }
        }
        .fullScreenCover(isPresented: $showTerminal) {
            if let client = appModel.client {
                TerminalScreen(sessionId: session.id, title: displayTitle(session), client: client)
            } else {
                // Race between the tap on "Terminal" (when `client` was not nil yet) and presenting the cover
                // (review) — without a fallback the fullScreenCover would show an empty black screen with no
                // way out, because unlike `.sheet` a `fullScreenCover` cannot be dismissed by swiping down.
                VStack(spacing: 16) {
                    Text("Lost connection to the devbox.")
                        .font(.headline)
                    Button("Close") { showTerminal = false }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Theme.C.background)
            }
        }
    }

    // MARK: - Private

    private let actionColumns = [GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8)]

    /// Action button in the detail grid — `DevboxButtonStyle` (web `Button`), stretched to the cell
    /// width so they all have the same target.
    private func actionButton(
        _ title: String, systemImage: String, variant: DevboxButtonStyle.Variant, action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Label(title, systemImage: systemImage)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(DevboxButtonStyle(variant: variant))
    }

    /// Consumes a pending deep link (push notification) belonging to this session — opens the terminal
    /// right away when the payload carried `terminal: true` (simplification from the plan: navigation to the detail
    /// always goes through `SessionsContainer`, the terminal is then opened from here automatically). `alertId`/ack is
    /// handled by `PushManager` itself when the notification is delivered, not here — this method only navigates and
    /// clears `pendingDeepLink` so it does not fire again on the next appearance/screen rotation.
    private func consumeDeepLinkIfNeeded() {
        guard case .session(let id, let terminal) = appModel.pendingDeepLink, id == sessionId else { return }
        appModel.pendingDeepLink = nil
        if terminal, appModel.client != nil {
            showTerminal = true
        }
    }

    private func run(_ operation: @escaping () async throws -> Void) {
        guard !busy else { return }
        busy = true
        errorMessage = nil
        Task {
            do {
                try await operation()
                await store.refreshNow()
            } catch {
                errorMessage = errorText(error)
            }
            busy = false
        }
    }

    private func loadReviewsIfNeeded(session: SessionLive) async {
        guard (session.critic ?? 0) == 1 else {
            reviews = []
            return
        }
        do {
            reviews = try await actions.reviews(session.id)
        } catch {
            reviews = []
        }
    }

    /// `GET /api/shares` is cross-session — the app fetches the whole list and the view (`body`)
    /// filters it by `session.id`. An error is (as with `loadReviewsIfNeeded`) silently
    /// hidden behind an empty list — the section is just not shown, rather than breaking the rest of the detail.
    private func loadShares(session: SessionLive) async {
        guard let client = appModel.client else { return }
        do {
            shares = try await client.shares()
        } catch {
            shares = []
        }
    }

    /// Share name in the list — nickname, otherwise repo (same as web `label` in `ActiveShares`).
    private func shareLabel(_ share: ActiveShare, session: SessionLive) -> String {
        let nick = share.name?.trimmingCharacters(in: .whitespacesAndNewlines)
        return (nick?.isEmpty == false ? nick : nil) ?? session.repo
    }

    /// Nickname when set and non-empty after trimming, otherwise repo — used for the navigation title
    /// and for the terminal title (`TerminalScreen`).
    private func displayTitle(_ session: SessionLive) -> String {
        let nick = session.name?.trimmingCharacters(in: .whitespacesAndNewlines)
        return (nick?.isEmpty == false ? nick : nil) ?? session.repo
    }

    private func metadataLine(_ session: SessionLive) -> String {
        var line = "\(session.folder) · \(session.container)"
        if session.solo == 1 { line += " · Solo workspace" }
        line += " · " + (session.status == .running ? Format.stateLabel(session.claudeState) : "stopped")
        return line
    }

    private func statItems(session: SessionLive, usage: SessionUsage?, now: Date, running: Bool) -> [(label: String, value: String)] {
        let nowMs = now.timeIntervalSince1970 * 1000
        return [
            (label: "Uptime", value: running ? Format.durationLabel(nowMs - Double(session.created_at)) : "—"),
            (label: "CPU", value: running ? "\(Int(session.cpuPct.rounded())) %" : "—"),
            (label: "RAM", value: running ? Format.bytes(session.memBytes) : "—"),
            (label: "Tokens today", value: usage.map { Format.compactNumber($0.tokens) } ?? "—"),
            (label: "Cost today", value: usage.map { Format.usd($0.cost) } ?? "—"),
        ]
    }
}

// MARK: - cc-upkeep (mirrors dashboard/src/ccUpkeepView.ts `isOlder`/`rowState`, narrowed to
// a binary "outdated or not" like the fleet badge in SessionsScreen.swift — this copy is
// file-private, a small duplication of the same pure logic across two screens, not a shared type).

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

private func isCcOutdated(_ status: CcSessionStatus, latest: String?) -> Bool {
    guard let version = status.version, let stale = status.stalePanes else { return false }
    if stale > 0 { return true }
    if let latest, isOlderVersion(version, latest) { return true }
    return false
}

// MARK: - Critic (simplified mirror of dashboard/src/criticView.ts — only badge + text lines,
// without full severity parsing into separate sections as on the web).

private struct DecodedFinding: Decodable {
    let severity: String?
    let file: String?
    let line: Int?
    let what: String
    let why: String?
}

private func parseFindings(_ raw: String) -> [DecodedFinding] {
    guard let data = raw.data(using: .utf8),
          let list = try? JSONDecoder().decode([DecodedFinding].self, from: data)
    else { return [] }
    return list
}

private func findingLines(_ review: CriticReview) -> [String] {
    parseFindings(review.findings).map { f in
        let location = f.file.map { "\($0)\(f.line.map { ":\($0)" } ?? "") — " } ?? ""
        let why = f.why.map { " (\($0))" } ?? ""
        return "\(location)\(f.what)\(why)"
    }
}

private func criticBadge(_ review: CriticReview?) -> (text: String, tone: Color)? {
    guard let review else { return nil }
    if review.verdict == .error { return ("Critic failed", Theme.C.dangerText) }
    let blocking = parseFindings(review.findings).filter { $0.severity == "critical" || $0.severity == "important" }.count
    if blocking == 0 { return ("Review passed", Theme.C.okText) }
    return ("\(blocking) \(blocking == 1 ? "issue" : "issues")", Theme.C.warnText)
}

// MARK: - Terminal sharing (mirrors dashboard/src/shareView.ts + dashboard/src/share/guest.ts
// `untilLabel`). `internal` (not `private`) — `ShareTests` checks the presets and wording directly, without
// having to build the whole UI.

enum ShareView {
    /// Validity presets offered in the UI — must match `SHARE_MAX_MINUTES` (1440) in
    /// `devd/src/shares.ts`, 1:1 `SHARE_PRESETS` from dashboard/src/shareView.ts.
    static let presets: [(label: String, minutes: Int)] = [
        ("30 min", 30), ("1 h", 60), ("4 h", 240), ("8 h", 480), ("24 h", 1440),
    ]

    /// "HH:MM" today, otherwise "M/D HH:MM" (a 24h share crosses midnight) — 1:1 `untilLabel` from
    /// dashboard/src/share/guest.ts, `ms` = epoch in milliseconds (as devd sends it).
    static func expiryLabel(_ ms: Double, now: Date = Date()) -> String {
        let calendar = Calendar.current
        let date = Date(timeIntervalSince1970: ms / 1000)
        let c = calendar.dateComponents([.year, .month, .day, .hour, .minute], from: date)
        let hm = String(format: "%02d:%02d", c.hour ?? 0, c.minute ?? 0)
        if calendar.isDate(date, inSameDayAs: now) { return hm }
        return "\(c.month ?? 0)/\(c.day ?? 0) \(hm)"
    }

    /// Fixed warning text (user decision, see the internal design notes — commit
    /// e1ead86) — 1:1 `shareWarning` from dashboard/src/shareView.ts, including punctuation.
    static func warning(expiresAtMs: Double, now: Date = Date()) -> String {
        "Anyone with the link gets full terminal access to this session until \(expiryLabel(expiresAtMs, now: now))"
            + " — they can see the code and may obtain your AI account logins (Claude, Codex)."
            + " Share only with people you trust."
    }

    /// After sharing the container stays restricted until it is rebuilt — 1:1 `TAINT_MESSAGE` /
    /// `TAINT_ACTION` from dashboard/src/shareView.ts.
    static let taintMessage = "Sharing ended — the session stays restricted until you rebuild it"
    static let taintAction = "Rebuild session"

    /// Live shares of the session: `GET /api/shares` is cross-session and the list is kept in memory between
    /// polls — expired rows are therefore filtered out here too (`expires_at > now`), as on the web.
    static func activeShares(_ shares: [ActiveShare], sessionId: String, now: Date = Date()) -> [ActiveShare] {
        let nowMs = Int(now.timeIntervalSince1970 * 1000)
        return shares.filter { $0.session_id == sessionId && $0.expires_at > nowMs }
    }

    /// Show "Sharing ended…" with a rebuild: the session is tainted and has no live share
    /// (that one is shown by the Active shares section).
    static func showsTaint(session: SessionLive, activeShares: [ActiveShare]) -> Bool {
        session.tainted == true && activeShares.isEmpty
    }

    /// Link state in the share sheet. An unreadable `url` from the server is an error, NOT a reason to offer
    /// "Create link" again (a second click would create another live share).
    enum LinkState: Equatable { case notCreated, ready(URL), invalid }
    static func linkState(_ created: TerminalShare?) -> LinkState {
        guard let created else { return .notCreated }
        guard let url = URL(string: created.url), url.scheme == "https", url.host != nil else { return .invalid }
        return .ready(url)
    }
    static let invalidLinkMessage = "The share was created, but its link couldn't be read. Revoke it under Active shares and try again."
}

/// "Share terminal" sheet opened from `SessionDetailView` — mirrors `ShareTerminalDialog` from
/// `dashboard/src/components/ShareTerminal.tsx`: validity choice → fixed warning → "Create
/// link" → system share sheet with the link. `client`/`sessionId` go via init (not via
/// `@EnvironmentObject`), the same lesson as with `TerminalScreen` in `SessionDetailView` above.
struct ShareSessionSheet: View {
    @Environment(\.dismiss) private var dismiss
    let client: DevdClient
    let sessionId: String
    /// Called right after a successful creation — bumps `sharesVersion` in the parent so Active
    /// shares are refetched without waiting for the next poll.
    let onCreated: () -> Void

    @State private var minutes = ShareView.presets[0].minutes
    @State private var created: TerminalShare?
    @State private var busy = false
    @State private var errorMessage: String?

    /// Until created, the warning computes "until when" from the currently selected preset (not the real
    /// server time) — same as the web (`created?.expiresAt ?? now + minutes * 60_000`).
    private var previewExpiresAtMs: Double {
        created.map { Double($0.expiresAt) } ?? Date().timeIntervalSince1970 * 1000 + Double(minutes) * 60_000
    }

    var body: some View {
        NavigationStack {
            Form {
                if created == nil {
                    Section {
                        Picker("Valid for", selection: $minutes) {
                            ForEach(ShareView.presets, id: \.minutes) { preset in
                                Text(preset.label).tag(preset.minutes)
                            }
                        }
                        .pickerStyle(.segmented)
                        .disabled(busy)
                    }
                }
                Section {
                    Label {
                        Text(ShareView.warning(expiresAtMs: previewExpiresAtMs))
                            .font(Theme.F.meta)
                    } icon: {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .foregroundStyle(Theme.C.warn)
                    }
                }
                switch ShareView.linkState(created) {
                case .ready(let url):
                    Section {
                        ShareLink(item: url) {
                            Label("Share link", systemImage: "square.and.arrow.up")
                        }
                        Text("This link is shown only now. Revoke it any time under Active shares.")
                            .font(Theme.F.meta)
                            .foregroundStyle(Theme.C.mutedForeground)
                    }
                case .invalid:
                    Section {
                        Text(ShareView.invalidLinkMessage)
                            .font(Theme.F.meta)
                            .foregroundStyle(Theme.C.dangerText)
                    }
                case .notCreated:
                    Section {
                        Button(busy ? "Creating…" : "Create link") { create() }
                            .disabled(busy)
                    }
                }
                if let errorMessage {
                    Text(errorMessage)
                        .font(Theme.F.meta)
                        .foregroundStyle(Theme.C.dangerText)
                }
            }
            .navigationTitle("Share terminal")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(created == nil ? "Cancel" : "Done") { dismiss() }
                }
            }
        }
    }

    private func create() {
        guard !busy else { return }
        busy = true
        errorMessage = nil
        Task {
            do {
                created = try await client.createShare(sessionId: sessionId, minutes: minutes)
                onCreated()
            } catch {
                errorMessage = errorText(error)
            }
            busy = false
        }
    }
}
