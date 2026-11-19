import SwiftUI

/// One thread item (dashboard/src/components/chat/MessageList.tsx): the user's message (right, with its images,
/// "queued" while it waits, "from the critic" for the critic's follow-up), the assistant's text, a tool call, a
/// request (open ones as a form) or a notice.
/// Equatable on what it shows (not the client or the answer callback), so an update re-renders only changed rows
/// instead of re-parsing every row's markdown.
struct MessageRow: View, Equatable {
    let row: ChatRow
    let sessionId: String
    let client: DevdClient
    let onAnswer: (String, String) async throws -> Void

    private var item: ThreadItem { row.item }
    private var pending: PendingRequest? { row.pending }
    private var queued: Bool { row.queued }
    private var critic: Bool { row.critic }

    static func == (a: MessageRow, b: MessageRow) -> Bool { a.row == b.row && a.sessionId == b.sessionId }

    var body: some View {
        switch item.kind {
        case .user: userBubble
        case .assistant:
            HStack(alignment: .lastTextBaseline, spacing: 2) {
                ChatText(item.text)
                if item.status == .streaming {
                    Image(systemName: "ellipsis").symbolEffect(.variableColor.iterative).foregroundStyle(Theme.C.mutedForeground)
                        .accessibilityLabel("writing")
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        case .tool: ToolCallView(item: item)
        case .request: request
        case .notice:
            Label { Text(item.text) } icon: { Image(systemName: "info.circle") }
                .font(Theme.F.meta)
                .foregroundStyle(Theme.C.mutedForeground)
                .padding(.horizontal, 12).padding(.vertical, 8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Theme.C.muted, in: RoundedRectangle(cornerRadius: Theme.R.md))
        }
    }

    private var userBubble: some View {
        HStack {
            Spacer(minLength: 48)
            VStack(alignment: .leading, spacing: 6) {
                if critic { Badge("from the critic", variant: .secondary) }
                if let paths = item.attachments {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 6) {
                            ForEach(paths, id: \.self) { AttachmentThumbnail(path: ImagePrep.attachmentPath(sessionId: sessionId, path: $0), client: client) }
                        }
                    }
                }
                Text(item.text).font(Theme.F.body).textSelection(.enabled)
                if queued { Badge("queued", variant: .secondary) }
            }
            .padding(.horizontal, 14).padding(.vertical, 8)
            .foregroundStyle(Theme.C.primaryForeground)
            .background(Theme.C.primary, in: RoundedRectangle(cornerRadius: 18))
            .opacity(queued ? 0.7 : 1)
        }
    }

    @ViewBuilder
    private var request: some View {
        if item.status == .open, let pending {
            RequestFormView(request: pending) { try await onAnswer(pending.requestId, $0) }
        } else {
            VStack(alignment: .leading, spacing: 6) {
                ChatText(item.text).foregroundStyle(Theme.C.mutedForeground)
                Group {
                    switch item.status {
                    case .answered: Text("answered: ").foregroundStyle(Theme.C.mutedForeground) + Text(item.output ?? "—")
                    case .expired: Text("expired without an answer").foregroundStyle(Theme.C.mutedForeground)
                    default: Text("waiting for an answer").foregroundStyle(Theme.C.mutedForeground)
                    }
                }
                .font(Theme.F.meta)
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.C.card, in: RoundedRectangle(cornerRadius: Theme.R.lg))
            .overlay(RoundedRectangle(cornerRadius: Theme.R.lg).strokeBorder(Theme.C.border))
        }
    }
}

/// Markdown text, inline syntax only (bold, code, links), line breaks kept.
struct ChatText: View {
    private let text: String
    init(_ text: String) { self.text = text }

    var body: some View {
        // Unparseable markdown (a stray bracket mid-stream) is shown as typed rather than not at all.
        let attributed = (try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
            ?? AttributedString(text)
        Text(attributed).font(Theme.F.body).textSelection(.enabled)
    }
}

/// A user image from devd (`GET /thread/attachments/:name`), loaded through `DevdClient` for the CF headers.
struct AttachmentThumbnail: View {
    let path: String
    let client: DevdClient
    @State private var image: PlatformImage?
    @State private var failed: String?
    @State private var full = false

    var body: some View {
        Group {
            if let image {
                Image(platformImage: image).resizable().scaledToFill()
                    .onTapGesture { full = true }
            } else if let failed {
                Image(systemName: "photo.badge.exclamationmark").accessibilityLabel("Image not loaded: \(failed)")
            } else {
                ProgressView()
            }
        }
        .frame(width: 96, height: 96)
        .clipShape(RoundedRectangle(cornerRadius: Theme.R.md))
        .task(id: path) {
            do {
                let data = try await client.getData(path)
                guard let img = PlatformImage(data: data) else { failed = "not an image"; return }
                image = img
            } catch {
                failed = errorText(error)
            }
        }
        .fullScreenOrSheet(isPresented: $full) {
            if let image {
                ZStack(alignment: .topTrailing) {
                    Color.black.ignoresSafeArea()
                    Image(platformImage: image).resizable().scaledToFit().frame(maxWidth: .infinity, maxHeight: .infinity)
                    Button("Close") { full = false }.padding().foregroundStyle(.white)
                }
            }
        }
    }
}
