import ActivityKit
import SwiftUI
import WidgetKit

@main
struct DevboxLiveActivityBundle: WidgetBundle {
    var body: some Widget {
        DevboxLiveActivity()
        DevboxStatusWidget()
        // Build 20: diagnostics of the production row with live time (delete after confirming on device).
        DevboxDiagElapsedWidget()
    }
}

/// One Live Activity for all agents; devd sends the content via APNs (ContentState v2).
/// Lock Screen = card B2; Dynamic Island just a dot in the summary state color, the expanded
/// island a shortened card (pills + 2 rows).
struct DevboxLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: DevboxAgentActivityAttributes.self) { context in
            AgentActivityCard(state: context.state, stale: context.isStale)
                .activityBackgroundTint(AgentActivityPalette.background)
                .activitySystemActionForegroundColor(.white)
                .widgetURL(B2Layout.tapURL(context.state))
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.bottom) {
                    // Build 20: the same views as the Lock Screen card, just two rows.
                    VStack(alignment: .leading, spacing: 6) {
                        AgentActivityHeader(state: context.state)
                        AgentActivityRows(state: context.state, maxRows: B2Layout.expandedRows, stale: context.isStale)
                        if context.isStale {
                            Text("Status is out of date")
                                .font(.system(size: 10.5))
                                .foregroundStyle(.white.opacity(0.85))
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                // Build 7: bottom padding so the last row does not collide with the rounded corners.
                .contentMargins(.bottom, 12)
            } compactLeading: {
                EmptyView()
            } compactTrailing: {
                Self.dot(context)
            } minimal: {
                Self.dot(context)
            }
            .widgetURL(B2Layout.tapURL(context.state))
            .keylineTint(AgentActivityPalette.color(context.state.dot, stale: context.isStale))
            // Build 7: horizontal padding of the expanded island from the rounded edges.
            .contentMargins(.horizontal, 20, for: .expanded)
        }
    }

    private static func dot(_ context: ActivityViewContext<DevboxAgentActivityAttributes>) -> some View {
        Circle()
            .fill(AgentActivityPalette.color(context.state.dot, stale: context.isStale))
            .frame(width: 8, height: 8)
            .accessibilityLabel(context.isStale ? "Status is out of date" : "Agent status")
    }
}

#Preview("Lock Screen", as: .content, using: DevboxAgentActivityAttributes(serverID: "preview")) {
    DevboxLiveActivity()
} contentStates: {
    DevboxAgentActivityAttributes.preview      // regular
    DevboxAgentActivityAttributes.previewWorking // nothing waiting
    DevboxAgentActivityAttributes.previewB2    // 13 sessions
}

#Preview("Dynamic Island", as: .dynamicIsland(.expanded), using: DevboxAgentActivityAttributes(serverID: "preview")) {
    DevboxLiveActivity()
} contentStates: {
    DevboxAgentActivityAttributes.previewB2
}

#Preview("Dynamic Island compact", as: .dynamicIsland(.compact), using: DevboxAgentActivityAttributes(serverID: "preview")) {
    DevboxLiveActivity()
} contentStates: {
    DevboxAgentActivityAttributes.previewB2
}
