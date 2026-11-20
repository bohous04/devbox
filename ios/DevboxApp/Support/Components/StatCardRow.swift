import SwiftUI

/// A few headline numbers: cards side by side where they fit (Mac, iPad), the compact `StatGrid` strip on an iPhone,
/// where three cards would stack into a screenful.
struct StatCardRow: View {
    let items: [(label: String, value: String, caption: String?)]

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: Theme.S.gridGap) {
                ForEach(items, id: \.label) { StatCard(label: $0.label, value: $0.value, caption: $0.caption).frame(width: 220) }
                Spacer(minLength: 0)
            }
            StatGrid(items.map { ($0.label, $0.value) }, minimumColumnWidth: 100)
        }
    }
}
