import SwiftUI

// Live Activity card in layout B2 ("what is being waited on"): pills with counts of all sessions at the top,
// below them the waiting ones with what the agent is waiting for, then the stalled ones; when nothing is waiting or stalled, three
// working ones. The footer says what did not fit and how old the last change is ("12 sec ago"). Height must stay ≤ 160 pt
// (build 7, ios-corners-fix.md) — test `AgentActivityRenderingTests.testLockScreenCardFitsHeight`.

/// State colors from spec §1. The extension does not link the app, hence here and not in `Theme`.
enum AgentActivityPalette {
    static let waiting = Color(red: 0xFE / 255, green: 0x9A / 255, blue: 0x00 / 255)
    static let working = Color(red: 0x00 / 255, green: 0xBC / 255, blue: 0x7D / 255)
    static let done = Color(red: 0x9F / 255, green: 0x9F / 255, blue: 0xA9 / 255)
    static let stalled = Color(red: 0xFB / 255, green: 0x2C / 255, blue: 0x36 / 255)
    static let unknown = Color.gray
    /// Dark Lock Screen material (mockup `rgba(28,28,30,.84)`).
    static let background = Color(red: 28 / 255, green: 28 / 255, blue: 30 / 255).opacity(0.84)
    /// The home screen widget has an opaque background (the system does not blur it itself like the Lock Screen).
    static let widgetBackground = Color(red: 28 / 255, green: 28 / 255, blue: 30 / 255)

    static func color(_ status: DevboxAgentActivityAttributes.Status, stale: Bool = false) -> Color {
        if stale { return unknown }
        switch status {
        case .waiting: return waiting
        case .working: return working
        case .done: return done
        case .stalled: return stalled
        case .unknown: return unknown
        }
    }

    static func color(_ dot: DevboxAgentActivityAttributes.Dot, stale: Bool = false) -> Color {
        if stale { return unknown }
        switch dot {
        case .waiting: return waiting
        case .stalled: return stalled
        case .working: return working
        case .idle: return done
        }
    }
}

/// One row of the card body. `detail` is the second row (what it waits for / why it is stalled); working ones have none.
struct V2SessionRow: Identifiable, Hashable {
    let id: String
    let title: String
    let status: DevboxAgentActivityAttributes.Status
    let agentLabel: String
    let detail: String?
    let since: Date
}

/// Pure B2 layout logic — what is shown, in what order, and what is left for the footer.
enum B2Layout {
    typealias State = DevboxAgentActivityAttributes.ContentState
    typealias Status = DevboxAgentActivityAttributes.Status

    /// Lock Screen and expanded Dynamic Island.
    static let lockScreenRows = 3
    static let expandedRows = 2
    private static let maxWaiting = 3

    /// Waiting (at most 3) → stalled; when nothing is waiting or stalled, working. Order within a state
    /// is kept by the server (oldest wait first).
    static func rows(_ s: State, maxRows: Int) -> [V2SessionRow] {
        let limit = max(0, maxRows)
        let waiting = s.sessions.filter { $0.status == .waiting }.prefix(min(maxWaiting, limit))
        let stalled = s.sessions.filter { $0.status == .stalled }.prefix(limit - waiting.count)
        let picked = waiting.isEmpty && stalled.isEmpty
            ? Array(s.sessions.filter { $0.status == .working }.prefix(limit))
            : Array(waiting) + Array(stalled)
        return picked.map(row)
    }

    /// Non-zero counts in the order waiting → working → done → stalled → ?.
    static func header(_ s: State) -> [(label: String, tone: Status)] {
        order.compactMap { status in
            let n = count(s.counts, status)
            return n > 0 ? (label(n, status), status) : nil
        }
    }

    /// "+ 8 working · 3 done" — counts minus what `rows(s, maxRows: shown)` showed. Unknown
    /// sessions do not belong here (they are only in the header). Empty string when everything fit.
    static func footer(_ s: State, shown: Int) -> String {
        let visible = rows(s, maxRows: shown)
        let parts: [String] = order.compactMap { status in
            guard status != .unknown else { return nil }
            let hidden = count(s.counts, status) - visible.filter { $0.status == status }.count
            return hidden > 0 ? label(hidden, status) : nil
        }
        return parts.isEmpty ? "" : "+ " + parts.joined(separator: " · ")
    }

    // MARK: Home screen widget

    /// Medium widget = `rows(_:maxRows:)` with two rows (waiting, otherwise working).
    static let mediumWidgetRows = 2
    /// Medium widget when nobody is waiting or stalled: working rows have no second reason row → 4 fit.
    static let mediumWidgetWorkingRows = 4

    /// Number of medium widget rows depending on whether the rows carry a reason.
    static func mediumRows(_ s: State) -> Int {
        s.sessions.contains { $0.status == .waiting || $0.status == .stalled } ? mediumWidgetRows : mediumWidgetWorkingRows
    }
    /// Large widget = up to 8 sessions in server order (`listRows`).
    static let largeWidgetRows = 8

    /// Sessions as the server ordered them (waiting → stalled → working → done → ?), without selection.
    static func listRows(_ s: State, maxRows: Int) -> [V2SessionRow] {
        s.sessions.prefix(max(0, maxRows)).map(row)
    }

    /// All sessions on the server, including those that did not fit into the payload.
    static func total(_ s: State) -> Int {
        max(order.reduce(0) { $0 + count(s.counts, $1) }, s.sessions.count)
    }

    /// "+N more" below the list.
    static func moreCount(_ s: State, shown: Int) -> Int {
        max(0, total(s) - shown)
    }

    /// Tapping opens the first waiting session, otherwise the session list.
    static func tapURL(_ s: State) -> URL {
        s.sessions.first { $0.status == .waiting }?.deepLink ?? URL(string: "devbox://sessions")!
    }

    private static let order: [Status] = [.waiting, .working, .done, .stalled, .unknown]

    private static func count(_ c: DevboxAgentActivityAttributes.Counts, _ status: Status) -> Int {
        switch status {
        case .waiting: return c.waiting
        case .working: return c.working
        case .done: return c.done
        case .stalled: return c.stalled
        case .unknown: return c.unknown
        }
    }

    /// Count with the state: "2 waiting", "8 working", "3 done", "1 stalled".
    private static func label(_ n: Int, _ status: Status) -> String {
        switch status {
        case .waiting: return "\(n) waiting"
        case .working: return "\(n) working"
        case .done: return "\(n) done"
        case .stalled: return "\(n) stalled"
        case .unknown: return "\(n) ?"
        }
    }

    private static func row(_ session: DevboxAgentActivityAttributes.Session) -> V2SessionRow {
        let reason = session.reason?.trimmingCharacters(in: .whitespacesAndNewlines)
        let detail: String?
        switch session.status {
        case .waiting:
            // Agent question in quotes, approvals (command, SSH key) without them — as in the mockup.
            if let reason, !reason.isEmpty {
                detail = reason.hasSuffix("?") ? "“\(reason)”" : reason
            } else {
                detail = "Waiting for a reply"
            }
        case .stalled:
            detail = (reason?.isEmpty == false) ? reason : "Not responding"
        default:
            detail = nil
        }
        return V2SessionRow(id: session.id, title: session.title, status: session.status,
                            agentLabel: session.agentLabel, detail: detail, since: session.since)
    }
}

// MARK: - Views

// Build 20 (B2 per the approved mockup): pills with counts, rows dot · name · live time,
// under a waiting one what it waits for, footer "+ 8 working · 3 done" / "12 sec ago".
//
// Evidence from device (build 19, diagnostic widgets): pills (test A) and "X ago" (test C)
// render; only the row with `AgentActivityElapsed().monospacedDigit().fixedSize()`
// next to a `Spacer` stayed empty (test B). Date-styled Text has unlimited ideal width in WidgetKit,
// and `.fixedSize()` on it breaks rendering of the whole activity / widget. Rules:
// - on date-styled Text (`.relative`, `.timer`, `timerInterval`) NEVER `.fixedSize()`,
//   `.monospacedDigit()` or `.minimumScaleFactor`; instead a fixed `.frame(width:)`
//   (`AgentActivityElapsed`, `AgentActivityAgo` have it built in),
// - no `.opacity` / `.foregroundStyle` on groups containing date Text — color directly on the Text,
// - no `Link` in the activity or the medium widget.
struct AgentActivityCard: View {
    let state: DevboxAgentActivityAttributes.ContentState
    let stale: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            AgentActivityHeader(state: state)
                .padding(.bottom, 2)
            AgentActivityRows(state: state, maxRows: B2Layout.lockScreenRows, stale: stale)
            AgentActivityFooter(state: state, stale: stale, shown: B2Layout.lockScreenRows)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .accessibilityElement(children: .contain)
    }
}

/// Medium widget content: the same views as the card, just two rows and no footer (like the medium
/// widget mockup; the save time is shown by the widget title, which the widget adds itself).
struct AgentActivityMediumContent: View {
    let state: DevboxAgentActivityAttributes.ContentState
    let stale: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            AgentActivityHeader(state: state)
            AgentActivityRows(state: state, maxRows: B2Layout.mediumRows(state), stale: stale)
        }
    }
}

/// Card rows: waiting ones with what they wait for, otherwise working ones.
struct AgentActivityRows: View {
    let state: DevboxAgentActivityAttributes.ContentState
    let maxRows: Int
    let stale: Bool

    var body: some View {
        let rows = B2Layout.rows(state, maxRows: maxRows)
        VStack(alignment: .leading, spacing: 3) {
            if rows.isEmpty {
                Text("Nobody is waiting on you")
                    .font(.system(size: 13))
                    .foregroundStyle(.white.opacity(0.65))
            }
            ForEach(rows) { row in
                AgentActivityRow(row: row, stale: stale)
            }
        }
    }
}

/// Production row: dot · bold name · live time on the right in the state color (fixed width), under a
/// waiting/stalled one an indented row with the reason. Diagnostic widget B renders exactly this.
struct AgentActivityRow: View {
    let row: V2SessionRow
    var stale: Bool = false

    private var tint: Color {
        row.status == .unknown ? AgentActivityPalette.done : AgentActivityPalette.color(row.status, stale: stale)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            HStack(spacing: 8) {
                Circle().fill(AgentActivityPalette.color(row.status, stale: stale)).frame(width: 8, height: 8)
                    .accessibilityHidden(true)
                Text(row.title)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(.white)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Spacer(minLength: 6)
                AgentActivityElapsed(since: row.since, color: tint)
            }
            if let detail = row.detail {
                Text(detail)
                    .font(.system(size: 11.5))
                    .foregroundStyle(.white.opacity(0.75))
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .padding(.leading, 16)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// Left "+ 8 working · 3 done", right "12 sec ago"; for stale state
/// "Status is out of date". Color and font on each Text separately, not on the group.
struct AgentActivityFooter: View {
    let state: DevboxAgentActivityAttributes.ContentState
    let stale: Bool
    let shown: Int

    private static let font = Font.system(size: 10.5)

    var body: some View {
        HStack(spacing: 8) {
            Text(B2Layout.footer(state, shown: shown))
                .font(Self.font)
                .foregroundStyle(.white.opacity(0.55))
                .lineLimit(1)
            Spacer(minLength: 6)
            if stale {
                Text("Status is out of date")
                    .font(Self.font)
                    .foregroundStyle(.white.opacity(0.85))
                    .lineLimit(1)
            } else {
                AgentActivityAgo(date: state.changedAt, font: Self.font, color: .white.opacity(0.55))
            }
        }
    }
}

extension DevboxAgentActivityAttributes.Status {
    /// State capitalized as in the widget mockup.
    var widgetLabel: String {
        switch self {
        case .waiting: return "Waiting"
        case .working: return "Working"
        case .done: return "Done"
        case .stalled: return "Stalled"
        case .unknown: return "?"
        }
    }
}

/// Pills with counts (zeros omitted), text in the state color. Verified on device (build 19, test A).
struct AgentActivityHeader: View {
    let state: DevboxAgentActivityAttributes.ContentState

    var body: some View {
        let items = B2Layout.header(state)
        HStack(spacing: 6) {
            if items.isEmpty {
                Text("Devbox").foregroundStyle(.white.opacity(0.8))
            }
            // An Identifiable struct, not an array of tuples with `id: \.tone`: WidgetKit archives the view before rendering,
            // and a ForEach over tuples keyed into the tuple dropped the content of the whole Live
            // Activity and the medium widget on device (empty black block; fine in the simulator/ImageRenderer).
            ForEach(items.map { HeaderPill(label: $0.label, tone: $0.tone) }) { item in
                Text(item.label)
                    .foregroundStyle(item.tone == .unknown ? AgentActivityPalette.done : AgentActivityPalette.color(item.tone))
                    .padding(.horizontal, 8)
                    .padding(.vertical, 2)
                    .background(Capsule().fill(.white.opacity(0.08)))
            }
        }
        .font(.system(size: 12.5, weight: .semibold).monospacedDigit())
        .lineLimit(1)
        .minimumScaleFactor(0.7)
    }
}

/// One header pill — stable `id` by state (each state at most once).
struct HeaderPill: Identifiable, Hashable {
    let label: String
    let tone: DevboxAgentActivityAttributes.Status
    var id: String { tone.rawValue }
}

/// How long the session has been in this state ("3 min", "3 min, 5 sec"). The system updates the text itself
/// even without a push. Fixed width instead of `.fixedSize()` (build 19, test B), English locale directly on the Text.
struct AgentActivityElapsed: View {
    static let width: CGFloat = 76

    let since: Date
    let color: Color
    var font: Font = .system(size: 12, weight: .semibold)

    var body: some View {
        // Classic `.relative` style (build 12 rendered with it on device). iOS 18
        // `Text(.currentDate, format:)` and `Text(timerInterval: …distantFuture)` both
        // broke rendering of the whole Live Activity and the medium widget on device (empty block).
        Text(min(since, Date()), style: .relative)
            .font(font)
            .foregroundStyle(color)
            .multilineTextAlignment(.trailing)
            .lineLimit(1)
            .environment(\.locale, Locale(identifier: "en_US"))
            .frame(width: Self.width, alignment: .trailing)
    }
}

/// "12 sec ago". A change from the future (server clock drift) is clamped to now so it never shows
/// "in …". Verified on device (build 19, test C); English via `en_US` (the "ago" around it is English), fixed
/// width because of the `Spacer`.
struct AgentActivityAgo: View {
    static let width: CGFloat = 108

    let date: Date
    var font: Font = .system(size: 12)
    var color: Color = .white.opacity(0.7)

    var body: some View {
        Text("\(Text(min(date, Date()), style: .relative)) ago")
            .font(font)
            .foregroundStyle(color)
            .multilineTextAlignment(.trailing)
            .lineLimit(1)
            .environment(\.locale, Locale(identifier: "en_US"))
            .frame(width: Self.width, alignment: .trailing)
    }
}

// MARK: - Sample data and previews

extension DevboxAgentActivityAttributes {
    /// Mockup B2: 13 sessions (2 waiting, 8 working, 3 done); the server sends the waiting ones + a few more.
    static var previewB2: ContentState {
        let now = Date(timeIntervalSince1970: Date().timeIntervalSince1970.rounded(.down))
        let working = ["Crafting", "Phd_discord", "Logs"].enumerated().map { index, title in
            Session(id: "dev-\(title.lowercased())", title: title, agent: index == 1 ? "codex" : "claude",
                    project: "portal/games", status: .working, since: now.addingTimeInterval(Double(-300 * (index + 1))))
        }
        return ContentState(
            counts: Counts(waiting: 2, working: 8, done: 3),
            dot: .waiting,
            sessions: [
                Session(id: "dev-notes", title: "Notes", agent: "claude", project: "portal/notes", status: .waiting,
                        reason: "Should I delete the old migrations or keep them?", since: now.addingTimeInterval(-180)),
                Session(id: "dev-portal-web", title: "game_web", agent: "codex", project: "portal/web",
                        status: .waiting, reason: "Approve SSH key: infra-root", since: now.addingTimeInterval(-60)),
            ] + working,
            overflow: 5,
            changedAt: now.addingTimeInterval(-12),
            updatedAt: now
        )
    }

    /// Nothing waiting or stalled — the card shows three working ones.
    static var previewWorking: ContentState {
        var state = previewB2
        state.sessions.removeAll { $0.status == .waiting }
        state.counts.waiting = 0
        state.dot = .working
        return state
    }
}

// Activity previews (Lock Screen, Dynamic Island) are in DevboxLiveActivity.swift; here
// only the stale state, which the `contentStates` preview cannot do.
#Preview("B2 · stale") {
    AgentActivityCard(state: DevboxAgentActivityAttributes.previewB2, stale: true)
        .background(AgentActivityPalette.background).frame(width: 360)
}
