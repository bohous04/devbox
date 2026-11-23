import SwiftUI

/// Above a thread loaded only to some point back (ThreadView.pageSize): loads the page before it
/// (dashboard/src/components/chat/OlderItems.tsx). A button, not a load on scroll: a page can add nothing shown (one
/// long run left out until its start is loaded, ThreadView.tailView), and then a row that is already on screen would
/// never appear again to ask for the next one.
struct OlderItemsButton: View {
    let loading: Bool
    let error: String?
    let load: () -> Void

    var body: some View {
        VStack(spacing: 6) {
            Button(action: load) {
                if loading { ProgressView().controlSize(.small) } else { Text("Load earlier messages") }
            }
            .buttonStyle(.bordered)
            .disabled(loading)
            if let error {
                Text("Could not load earlier messages: \(error)").font(Theme.F.meta).foregroundStyle(Theme.C.dangerText)
            }
        }
        .frame(maxWidth: .infinity)
    }
}
