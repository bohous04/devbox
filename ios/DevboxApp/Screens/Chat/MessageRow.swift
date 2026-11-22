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
    /// The notice is its run's failure (run.failed), not devd's or the bridge's own.
    private var failedRun: Bool { row.failedRun }

    static func == (a: MessageRow, b: MessageRow) -> Bool { a.row == b.row && a.sessionId == b.sessionId }

    var body: some View {
        switch item.kind {
        case .user: userBubble
        case .assistant:
            VStack(alignment: .leading, spacing: 4) {
                ChatMarkdown(text: item.text)
                if item.status == .streaming {
                    Image(systemName: "ellipsis").symbolEffect(.variableColor.iterative).foregroundStyle(Theme.C.mutedForeground)
                        .accessibilityLabel("writing")
                }
            }
        case .tool: ToolCallView(item: item)
        case .request: request
        case .notice, .unknown: notice // an item kind of a later devd: its text, shown like a notice rather than dropped
        }
    }

    /// A run's failure stays prominent, and so does a notice the user has to act on (tone "warn"); devd's and the
    /// bridge's other notices (and an unknown kind) are a faint centred line between hairlines.
    @ViewBuilder
    private var notice: some View {
        if item.kind == .notice, failedRun {
            Label { Text(item.text) } icon: { Image(systemName: "exclamationmark.circle") }
                .font(Theme.F.meta).foregroundStyle(Theme.C.dangerText)
                .frame(maxWidth: .infinity, alignment: .leading)
        } else if item.kind == .notice, item.warns {
            Label { Text(item.text) } icon: { Image(systemName: "exclamationmark.triangle") }
                .font(Theme.F.meta).foregroundStyle(Theme.C.warnText)
                .frame(maxWidth: .infinity, alignment: .leading)
        } else {
            HStack(spacing: 10) {
                Rectangle().fill(Theme.C.border).frame(height: 1 / 3)
                Text(item.text).font(.system(size: ChatType.s(11))).foregroundStyle(Theme.C.mutedForeground).multilineTextAlignment(.center)
                    .layoutPriority(1)
                Rectangle().fill(Theme.C.border).frame(height: 1 / 3)
            }
            .padding(.vertical, 2)
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
                ClampedText(text: item.text)
                if queued { Badge("queued", variant: .secondary) }
            }
            .padding(.horizontal, 14).padding(.vertical, 10)
            .foregroundStyle(Theme.C.foreground)
            // Quiet: the answer, not the prompt, is what the thread is read for.
            .background(Theme.C.muted, in: UnevenRoundedRectangle(topLeadingRadius: 18, bottomLeadingRadius: 18, bottomTrailingRadius: 6, topTrailingRadius: 18))
            .overlay(UnevenRoundedRectangle(topLeadingRadius: 18, bottomLeadingRadius: 18, bottomTrailingRadius: 6, topTrailingRadius: 18).strokeBorder(Theme.C.border.opacity(0.7)))
            .opacity(queued ? 0.7 : 1)
            .frame(maxWidth: ChatLayout.bubble, alignment: .trailing)
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

/// A long prompt folds (six lines, three on the Mac) so it does not outweigh the answer; "Show more" opens it in place. The toggle
/// shows only when the text really is longer (measured against the same text unclamped).
struct ClampedText: View {
    let text: String
    @State private var open = false
    @State private var full: CGFloat = 0
    @State private var clamped: CGFloat = 0

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(LinkDetector.attributed(text)).font(.system(size: ChatLayout.bubbleText)).lineSpacing(3).textSelection(.enabled)
                .lineLimit(open ? nil : ChatLayout.bubbleLines)
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { if !open { clamped = $0 } }
                .background(alignment: .topLeading) {
                    // The same text unclamped, invisible, for its real height.
                    Text(LinkDetector.attributed(text)).font(.system(size: ChatLayout.bubbleText)).lineSpacing(3).fixedSize(horizontal: false, vertical: true)
                        .hidden()
                        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { full = $0 }
                }
            if open || full > clamped + 1 {
                Button(open ? "Show less" : "Show more") { withAnimation(.snappy) { open.toggle() } }
                    .font(.system(size: ChatType.s(14), weight: .medium)).foregroundStyle(Theme.C.mutedForeground)
                    .buttonStyle(.plain)
            }
        }
    }
}

/// Markdown text, inline syntax only (bold, code, links), line breaks kept.
struct ChatText: View {
    private let text: String
    init(_ text: String) { self.text = text }

    var body: some View {
        Text(ChatInline.attributed(text)).font(Theme.F.body).textSelection(.enabled)
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
