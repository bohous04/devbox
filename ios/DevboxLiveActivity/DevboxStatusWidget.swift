import SwiftUI
import WidgetKit

// Home screen widget with the same state as the Live Activity. The app writes the data into the App Group
// (`SharedActivityStore`); the extension has no network or credentials, so freshness is set by the last
// app open / a push that arrived while it was running. Medium: content of the Live Activity card B2
// (pills, 2 rows with live time and the waiting reason, footer). Large: "Devbox · N sessions" + up to 8 sessions in server order.

struct DevboxStatusEntry: TimelineEntry {
    let date: Date
    /// `nil` = the app has not saved anything yet.
    let state: DevboxAgentActivityAttributes.ContentState?
    let savedAt: Date?

    var isStale: Bool {
        guard let savedAt else { return false }
        return SharedActivityStore.isStale(savedAt: savedAt, now: date)
    }
}

struct DevboxStatusProvider: TimelineProvider {
    func placeholder(in context: Context) -> DevboxStatusEntry {
        DevboxStatusEntry(date: .now, state: DevboxAgentActivityAttributes.previewB2, savedAt: .now)
    }

    func getSnapshot(in context: Context, completion: @escaping (DevboxStatusEntry) -> Void) {
        // Before the first app open the widget gallery shows sample data, not "Open Devbox".
        let entry = current()
        completion(context.isPreview && entry.state == nil ? placeholder(in: context) : entry)
    }

    /// Current entry + an entry at the moment the data go stale (exactly 15 min after saving it
    /// switches to "Out of date"); after 15 min the widget asks again.
    func getTimeline(in context: Context, completion: @escaping (Timeline<DevboxStatusEntry>) -> Void) {
        let now = Date.now
        let stored = SharedActivityStore.read()
        let entries = SharedActivityStore.timelineDates(now: now, savedAt: stored?.savedAt).map {
            DevboxStatusEntry(date: $0, state: stored?.state, savedAt: stored?.savedAt)
        }
        completion(Timeline(entries: entries, policy: .after(now.addingTimeInterval(SharedActivityStore.staleAfter))))
    }

    private func current() -> DevboxStatusEntry {
        let stored = SharedActivityStore.read()
        return DevboxStatusEntry(date: .now, state: stored?.state, savedAt: stored?.savedAt)
    }
}

struct DevboxStatusWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: SharedActivityStore.widgetKind, provider: DevboxStatusProvider()) { entry in
            DevboxStatusWidgetView(entry: entry)
                .containerBackground(for: .widget) { AgentActivityPalette.widgetBackground }
        }
        .configurationDisplayName("Devbox")
        .description("Which sessions are waiting on you and how many are working.")
        .supportedFamilies([.systemMedium, .systemLarge])
    }
}

struct DevboxStatusWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: DevboxStatusEntry

    var body: some View {
        Group {
            if let state = entry.state, let savedAt = entry.savedAt {
                VStack(alignment: .leading, spacing: 6) {
                    if family == .systemLarge {
                        LargeStatus(state: state, savedAt: savedAt, stale: entry.isStale)
                    } else {
                        MediumStatus(state: state, savedAt: savedAt, stale: entry.isStale)
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                .widgetURL(B2Layout.tapURL(state))
            } else {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Devbox").font(.system(size: 12)).foregroundStyle(.white.opacity(0.7))
                    Spacer()
                    Text("Open Devbox").font(.system(size: 15, weight: .semibold))
                    Text("Agent status appears after you first open the app.")
                        .font(.system(size: 12))
                        .foregroundStyle(.white.opacity(0.65))
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                .widgetURL(URL(string: "devbox://sessions")!)
            }
        }
        .foregroundStyle(.white)
    }
}

/// "Devbox" on the left, save time on the right, or "Out of date · X ago".
private struct WidgetTitleBar: View {
    let title: String
    let savedAt: Date
    let stale: Bool

    var body: some View {
        HStack(spacing: 6) {
            Text(title).lineLimit(1)
            Spacer(minLength: 6)
            if stale {
                HStack(spacing: 0) {
                    Text("Out of date · ")
                    AgentActivityAgo(date: savedAt)
                }
                .foregroundStyle(AgentActivityPalette.waiting)
                .lineLimit(1)
            } else {
                Text(savedAt, style: .time)
            }
        }
        .font(.system(size: 12))
        .foregroundStyle(.white.opacity(0.7))
    }
}

/// Build 19: safe title for the medium and diagnostic widgets — "Devbox" and save time only
/// via `Text(_, style: .time)` (verified with the large widget), staleness as plain text.
struct SafeWidgetTitleBar: View {
    let title: String
    let savedAt: Date
    let stale: Bool

    var body: some View {
        HStack(spacing: 6) {
            Text(title).lineLimit(1)
            Spacer(minLength: 6)
            if stale {
                Text("Out of date")
                    .foregroundStyle(AgentActivityPalette.waiting)
                    .lineLimit(1)
            }
            Text(savedAt, style: .time)
        }
        .font(.system(size: 12))
        .foregroundStyle(.white.opacity(0.7))
    }
}

/// Build 20: small "Devbox" title + time, below it the same content as the Live Activity card
/// (`AgentActivityMediumContent`). For rules on date Text see `AgentActivityCard`.
private struct MediumStatus: View {
    let state: DevboxAgentActivityAttributes.ContentState
    let savedAt: Date
    let stale: Bool

    var body: some View {
        SafeWidgetTitleBar(title: "Devbox", savedAt: savedAt, stale: stale)
        AgentActivityMediumContent(state: state, stale: stale)
    }
}

private struct LargeStatus: View {
    let state: DevboxAgentActivityAttributes.ContentState
    let savedAt: Date
    let stale: Bool

    var body: some View {
        let rows = B2Layout.listRows(state, maxRows: B2Layout.largeWidgetRows)
        let more = B2Layout.moreCount(state, shown: rows.count)
        let total = B2Layout.total(state)
        WidgetTitleBar(title: "Devbox · \(total) \(total == 1 ? "session" : "sessions")", savedAt: savedAt, stale: stale)
        Group {
            if rows.isEmpty {
                Text("No running sessions")
                    .font(.system(size: 13))
                    .foregroundStyle(.white.opacity(0.65))
            }
            ForEach(rows) { row in
                WidgetSessionRow(row: row)
            }
        }
        .opacity(stale ? 0.6 : 1)
        Spacer(minLength: 0)
        HStack {
            Text(more > 0 ? "+\(more) more" : "")
            Spacer()
            Text("Tap for details")
        }
        .font(.system(size: 11))
        .foregroundStyle(.white.opacity(0.55))
    }
}

/// Large widget row: dot · name · state on the right ("Waiting"). Tapping the row opens that session.
private struct WidgetSessionRow: View {
    let row: V2SessionRow

    private var tint: Color { AgentActivityPalette.color(row.status) }

    var body: some View {
        let content = HStack(spacing: 8) {
            Circle().fill(tint).frame(width: 8, height: 8)
                .accessibilityHidden(true)
            Text(row.title)
                .font(.system(size: 13.5, weight: .semibold))
                .lineLimit(1)
                .truncationMode(.tail)
            Spacer(minLength: 6)
            Text(row.status.widgetLabel)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(row.status == .unknown ? AgentActivityPalette.done : tint)
                .lineLimit(1)
                .fixedSize()
        }
        .padding(.vertical, 3)
        .accessibilityElement(children: .combine)

        if let url = DevboxAgentActivityAttributes.sessionURL(row.id) {
            Link(destination: url) { content }
        } else {
            content
        }
    }
}

// MARK: - Diagnostic widget (build 20)

// Renders the safe title and exactly the production row (`AgentActivityRow` with live time at a fixed
// width) — confirms on device that the test B fix from build 19 holds. Delete after confirmation.

private struct DiagRowWidgetView: View {
    let entry: DevboxStatusEntry

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let state = entry.state, let savedAt = entry.savedAt {
                SafeWidgetTitleBar(title: "Devbox test B", savedAt: savedAt, stale: entry.isStale)
                if let row = B2Layout.rows(state, maxRows: 1).first {
                    AgentActivityRow(row: row, stale: entry.isStale)
                } else {
                    Text("No sessions").font(.system(size: 13)).foregroundStyle(.white.opacity(0.65))
                }
            } else {
                Text("Devbox test B").font(.system(size: 12)).foregroundStyle(.white.opacity(0.7))
                Text("Open Devbox").font(.system(size: 15, weight: .semibold)).foregroundStyle(.white)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

/// Test B: production row with live time (`AgentActivityRow`).
struct DevboxDiagElapsedWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: SharedActivityStore.diagWidgetKind, provider: DevboxStatusProvider()) { entry in
            DiagRowWidgetView(entry: entry)
                .containerBackground(for: .widget) { AgentActivityPalette.widgetBackground }
        }
        .configurationDisplayName("Devbox test B")
        .description("Diagnostics: row with live time.")
        .supportedFamilies([.systemMedium])
    }
}

// MARK: - Previews

#Preview("Medium", as: .systemMedium) {
    DevboxStatusWidget()
} timeline: {
    DevboxStatusEntry(date: .now, state: DevboxAgentActivityAttributes.previewB2, savedAt: .now)
    DevboxStatusEntry(date: .now, state: DevboxAgentActivityAttributes.previewWorking, savedAt: .now)
    DevboxStatusEntry(date: .now, state: DevboxAgentActivityAttributes.previewB2, savedAt: .now.addingTimeInterval(-40 * 60))
    DevboxStatusEntry(date: .now, state: nil, savedAt: nil)
}

#Preview("Large", as: .systemLarge) {
    DevboxStatusWidget()
} timeline: {
    DevboxStatusEntry(date: .now, state: DevboxAgentActivityAttributes.previewB2, savedAt: .now)
    DevboxStatusEntry(date: .now, state: DevboxAgentActivityAttributes.preview, savedAt: .now.addingTimeInterval(-40 * 60))
}
