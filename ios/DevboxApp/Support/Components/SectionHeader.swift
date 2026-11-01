import SwiftUI

/// Port of the web `Section` header (`primitives.tsx`) — label in capitals, muted, tracking-wider;
/// `trailing` is the web `meta` (the app limits it to text, no section needs more today).
struct SectionHeader: View {
    private let title: String
    private let trailing: String?

    init(_ title: String, trailing: String? = nil) {
        self.title = title
        self.trailing = trailing
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title)
                .font(Theme.F.sectionLabel)
                .textCase(.uppercase)
                .tracking(0.6)
                .foregroundStyle(Theme.C.mutedForeground)
            Spacer()
            if let trailing {
                Text(trailing)
                    .font(Theme.F.meta)
                    .foregroundStyle(Theme.C.mutedForeground)
            }
        }
        .frame(minHeight: 32)
    }
}

#Preview("SectionHeader") {
    VStack(alignment: .leading, spacing: 16) {
        SectionHeader("Today")
        SectionHeader("Sessions", trailing: "13 running")
    }
    .padding()
    .background(Theme.C.background)
}
