import SwiftUI

/// An ended session's transcript, read-only (dashboard/src/pages/EndedPage.tsx): the conversation as the thread showed
/// it and, in the composer's place, one line and the button that continues the work in a new session.
struct EndedTranscriptScreen: View {
    let endedId: String
    let client: DevdClient
    /// Opens the new session once devd started it (the iPhone's stack, the Mac window's selection).
    let onContinued: (String) -> Void
    @ObservedObject private var continues = EndedContinues.shared
    @State private var ended: EndedSession?
    @State private var thread: ThreadSnapshot?
    @State private var loadError: String?
    @State private var startError: String?
    /// Only the newest ThreadView.pageSize items load at first (as ThreadStore): older ones go in front on request,
    /// their rows' ids counting down from `rowBase` so the rows already shown keep theirs.
    @State private var hasOlder = false
    @State private var loadingOlder = false
    @State private var olderError: String?
    @State private var rowBase = 0
    /// The transcript the screen loaded last: a page back asked for another one (the Mac reuses the screen) is dropped.
    @State private var loadedFor: String?

    private var starting: Bool { continues.running.contains(endedId) }

    var body: some View {
        Group {
            if let ended, let thread {
                conversation(ended, thread)
            } else if let loadError {
                ContentUnavailableView("Could not load the transcript", systemImage: "bubble.left.and.exclamationmark.bubble.right",
                                       description: Text(loadError))
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(Theme.C.background)
        .navigationTitle(ended.map(InboxView.endedTitle) ?? "Transcript")
        .inlineNavigationTitle()
        .solidNavigationBar()
        .hidesTabBar()
        .task(id: endedId) {
            // A continue started before this screen (re)opened: wait for it and open its session.
            if starting { await startContinue() }
            await load()
        }
    }

    private func load() async {
        loadedFor = endedId
        do {
            let e: EndedSession = try await client.get("/api/ended/\(pathSegment(endedId))")
            // A session that ended without a transcript has nothing to fetch (devd answers 410).
            if e.transcript == .missing { thread = .empty } else {
                let t: ThreadSnapshot = try await client.get("/api/ended/\(pathSegment(endedId))/transcript?limit=\(ThreadView.pageSize)")
                hasOlder = ThreadView.hasOlder(t)
                rowBase = 0
                olderError = nil
                thread = t
            }
            ended = e
        } catch {
            loadError = errorText(error)
        }
    }

    private func loadOlder() async {
        guard hasOlder, !loadingOlder, let cur = thread, let before = ThreadView.olderBeforeSeq(cur) else { return }
        let asked = endedId
        loadingOlder = true
        defer { loadingOlder = false }
        do {
            let page: ThreadSnapshot = try await client.get("/api/ended/\(pathSegment(endedId))/transcript?beforeSeq=\(before)&limit=\(ThreadView.pageSize)")
            guard loadedFor == asked, let cur = thread else { return }
            // A transcript gets no live updates: nothing is held, and everything new goes in front.
            let more = ThreadView.hasOlder(page)
            let next = ThreadView.prependOlder(cur, page.items, pageSeq: page.lastSeq, more: more)
            rowBase -= ThreadView.shownItems(next).count - ThreadView.shownItems(cur).count
            hasOlder = more
            olderError = nil
            thread = next
        } catch {
            olderError = errorText(error)
        }
    }

    private func startContinue() async {
        startError = nil
        do {
            let r = try await continues.start(endedId, client: client)
            onContinued(r.sessionId)
        } catch {
            startError = chatErrorText(error)
        }
    }

    private func layout(_ t: ThreadSnapshot) -> [ThreadDisplayRow] {
        // A transcript takes no answers: an open request shows as it was left, without its form.
        var shown = t
        shown.pending = []
        let (chat, partialRun) = ThreadView.tailView(ThreadStore.chatRows(shown, idBase: rowBase), hasOlder: hasOlder, runs: shown.runs, pending: [])
        return WorkGroups.rows(chat, runs: shown.runs, partialRun: partialRun)
    }

    private func conversation(_ e: EndedSession, _ t: ThreadSnapshot) -> some View {
        let rows = layout(t)
        let turnStarts = WorkGroups.turnStarts(rows)
        return ScrollViewReader { proxy in ScrollView {
            LazyVStack(alignment: .leading, spacing: 16) {
                if let note = InboxView.transcriptNote(e.transcript) {
                    Text(note).font(.subheadline).foregroundStyle(Theme.C.mutedForeground)
                        .padding(.horizontal, 12).padding(.vertical, 8)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Theme.C.muted.opacity(0.5), in: RoundedRectangle(cornerRadius: Theme.R.md))
                }
                if hasOlder {
                    OlderItemsButton(loading: loadingOlder, error: olderError) {
                        // Keep the row that was first where it was (or its run's fold).
                        let first = rows.first
                        Task {
                            await loadOlder()
                            if let first, let t = thread, let id = WorkGroups.anchor(for: first, in: layout(t)) { proxy.scrollTo(id, anchor: .top) }
                        }
                    }
                }
                if rows.isEmpty, e.transcript != .missing { EmptyState("No messages — the session ended before anything was said.", systemImage: "bubble.left") }
                ForEach(rows) { row in
                    switch row {
                    case .work(let w): WorkGroupView(work: w).equatable()
                    case .item(let r, _):
                        MessageRow(row: r, sessionId: e.sessionId, client: client,
                                   onAnswer: { _, _ in throw TranscriptReadOnly() }, endedId: e.id)
                            .equatable()
                            .padding(.top, turnStarts.contains(row.id) ? ChatLayout.turnGap : 0)
                    }
                }
            }
            .padding(Theme.S.screenPadding)
            .padding(.top, ChatLayout.top)
            .frame(maxWidth: ChatLayout.column)
            .frame(maxWidth: .infinity)
        }
        .defaultScrollAnchor(.bottom)
        }
        .safeAreaInset(edge: .bottom) {
            VStack(alignment: .leading, spacing: 6) {
                Group {
                    if InboxView.canContinue(e) {
                        ViewThatFits(in: .horizontal) {
                            HStack(spacing: 12) { line; Spacer(minLength: 0); button(e) }
                            VStack(alignment: .leading, spacing: 10) { line; button(e).frame(maxWidth: .infinity) }
                        }
                    } else {
                        line.frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                .padding(.horizontal, 14).padding(.vertical, 12)
                .background(Theme.C.card, in: RoundedRectangle(cornerRadius: Theme.R.md))
                .overlay(RoundedRectangle(cornerRadius: Theme.R.md).stroke(Theme.C.border, lineWidth: 1))
                if let startError {
                    Text("Could not start the new session: \(startError)").font(Theme.F.meta).foregroundStyle(Theme.C.dangerText)
                }
            }
            .padding(.horizontal, Theme.S.screenPadding)
            .frame(maxWidth: ChatLayout.column)
            .frame(maxWidth: .infinity)
            .padding(.top, 8).padding(.bottom, 6)
            .background(Theme.C.background.ignoresSafeArea(.all, edges: .bottom))
        }
        .environment(\.openURL, OpenURLAction { url in ChatMarkdownParse.isWebLink(url) ? .systemAction : .discarded })
    }

    private var line: some View {
        Text("This is only a transcript.").font(.subheadline).foregroundStyle(Theme.C.mutedForeground)
    }

    private func button(_ e: EndedSession) -> some View {
        Button {
            Task { await startContinue() }
        } label: {
            Text(starting ? "Starting…" : InboxView.continueLabel(e.continueMode))
        }
        .buttonStyle(.borderedProminent)
        .disabled(starting)
    }
}

private struct TranscriptReadOnly: LocalizedError {
    var errorDescription: String? { "A transcript takes no answers." }
}
