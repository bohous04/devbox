import SwiftUI

/// The session worktree's changes against devd's base, under the thread's latest answer (dashboard ChangesCard.tsx):
/// files under their folders with a status letter and +/− counts; each file opens its diff in place. It is the
/// worktree's state now, not this turn's diff, and says what it compares against. Loading, a clean worktree and a
/// repository without commits show nothing; a failed load says so with a retry.
struct ChangesCard: View {
    /// The latest run's end seq: a new one refetches the card (and drops its cached diffs).
    let refreshKey: Int?
    @StateObject private var store: ChangesStore
    /// The list is open. The thread keeps it: a lazy stack builds the card only on screen, so the header's changes
    /// chip opens it there, before the card exists.
    @Binding var open: Bool
    @State private var shown: Set<String> = []

    init(sessionId: String, client: DevdClient, refreshKey: Int?, open: Binding<Bool>) {
        self.refreshKey = refreshKey
        _open = open
        _store = StateObject(wrappedValue: ChangesStore(sessionId: sessionId, client: client))
    }

    var body: some View {
        content
            .task(id: refreshKey) {
                await store.load()
                shown = []
            }
            // Off screen (scrolled away, the thread closed): no diff keeps downloading for nobody.
            .onDisappear { store.cancelDiffs() }
    }

    @ViewBuilder
    private var content: some View {
        switch store.state {
        case .loading, .none:
            // Not EmptyView: an empty view never appears, so its task (the fetch) would never run.
            Color.clear.frame(height: 0).accessibilityHidden(true)
        case .failed(let error):
            HStack(spacing: 8) {
                Text("Couldn't load changes").accessibilityHint(error)
                Button { Task { await store.load() } } label: { Label("Retry", systemImage: "arrow.clockwise") }
                    .buttonStyle(.borderless)
            }
            .font(Theme.F.meta).foregroundStyle(Theme.C.mutedForeground)
        case .loaded(let c):
            card(c)
        }
    }

    private func card(_ c: SessionChanges) -> some View {
        let groups = ChangesView.groupByFolder(c.files)
        let allShown = c.files.allSatisfy { shown.contains($0.path) }
        return VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 4) {
                Button { withAnimation(.snappy) { open.toggle() } } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "doc.badge.plus").foregroundStyle(Theme.C.mutedForeground).accessibilityHidden(true)
                        Text(ChangesView.title(c)).fontWeight(.medium).foregroundStyle(Theme.C.foreground).fixedSize()
                        Stat(added: c.totals.added, removed: c.totals.removed)
                        if ChangesView.countsIncomplete(c) {
                            Text("counts incomplete").font(Theme.F.meta).foregroundStyle(Theme.C.warnText).fixedSize()
                        }
                        // Next to the title, apart from "Open diffs": the chevron belongs to the list, not to that button.
                        Image(systemName: "chevron.down").font(.system(size: ChatType.s(12), weight: .semibold))
                            .foregroundStyle(Theme.C.mutedForeground)
                            .rotationEffect(.degrees(open ? 180 : 0)).accessibilityHidden(true)
                        Spacer(minLength: 4)
                    }
                    .frame(minHeight: 44)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityValue(open ? "expanded" : "collapsed")
                .accessibilityHint("Changes against \(c.base)")
                if c.files.count <= ChangesView.openAllMax {
                    Button(allShown ? "Hide diffs" : "Open diffs") {
                        withAnimation(.snappy) {
                            open = true
                            shown = allShown ? [] : Set(c.files.map(\.path))
                        }
                    }
                    .font(.system(size: ChatType.s(13), weight: .medium)).foregroundStyle(Theme.C.mutedForeground)
                    .buttonStyle(.borderless)
                    .frame(minHeight: 44)
                }
            }
            .padding(.leading, 12).padding(.trailing, 10)

            if open {
                VStack(alignment: .leading, spacing: 0) {
                    Text("vs \(c.base)").font(Theme.F.meta).foregroundStyle(Theme.C.mutedForeground)
                        .lineLimit(1).truncationMode(.middle)
                        .padding(.horizontal, 12).padding(.bottom, 4)
                    ForEach(groups, id: \.dir) { g in
                        if !g.dir.isEmpty {
                            HStack(spacing: 6) {
                                Image(systemName: "folder").font(.system(size: ChatType.s(12))).accessibilityHidden(true)
                                escapedText(g.dir).lineLimit(1).truncationMode(.middle)
                                Spacer(minLength: 4)
                                // One folder's sum would only repeat the header's totals.
                                if groups.count > 1, g.files.count > 1 { Stat(added: g.added, removed: g.removed) }
                            }
                            .font(.system(size: ChatType.s(13), design: .monospaced)).foregroundStyle(Theme.C.mutedForeground)
                            .padding(.horizontal, 12).padding(.top, 6).padding(.bottom, 2)
                        }
                        ForEach(g.files, id: \.path) { f in fileRow(f, indent: !g.dir.isEmpty) }
                    }
                    if c.truncated == true {
                        Text("\(c.files.count) of \(c.totals.files) files listed").font(Theme.F.meta)
                            .foregroundStyle(Theme.C.mutedForeground).padding(.horizontal, 12).padding(.top, 4)
                    }
                }
                .padding(.vertical, 6)
                .overlay(alignment: .top) { Rectangle().fill(Theme.C.border).frame(height: 1 / 3) }
            }
        }
        .font(.system(size: ChatType.s(14)))
        .background(Theme.C.card.opacity(0.4), in: RoundedRectangle(cornerRadius: Theme.R.lg))
        .overlay(RoundedRectangle(cornerRadius: Theme.R.lg).strokeBorder(Theme.C.border))
        .clipShape(RoundedRectangle(cornerRadius: Theme.R.lg))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Changed files")
    }

    private func fileRow(_ f: ChangedFile, indent: Bool) -> some View {
        let isShown = shown.contains(f.path)
        let name = ChangesView.splitPath(f.path).name
        let full = (f.oldPath.map { "\($0) → \(f.path)" } ?? f.path) + (f.nameNotUtf8 == true ? " (name is not valid UTF-8)" : "")
        return VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(.snappy) { if isShown { shown.remove(f.path) } else { shown.insert(f.path) } }
            } label: {
                HStack(spacing: 8) {
                    Text(ChangesView.letter(f.status)).fontWeight(.semibold).foregroundStyle(Self.color(f.status))
                        .frame(width: 12).accessibilityLabel(f.status.rawValue)
                    (f.oldPath.map { (escapedText(ChangesView.splitPath($0).name) + Text(" → ")).foregroundColor(Theme.C.mutedForeground) } ?? Text(""))
                        + escapedText(name).foregroundColor(Theme.C.foreground.opacity(0.9))
                    #if !os(macOS)
                    Spacer(minLength: 4)
                    #endif
                    // On a wide Mac row the counts sit beside the name, not across the window from it.
                    if let s = ChangesView.stat(f) {
                        Stat(added: s.added, removed: s.removed)
                    } else {
                        Text("not counted").foregroundStyle(Theme.C.mutedForeground)
                    }
                    #if os(macOS)
                    Spacer(minLength: 4)
                    #endif
                    Image(systemName: "chevron.right").font(.system(size: ChatType.s(11), weight: .semibold)).foregroundStyle(Theme.C.mutedForeground)
                        .rotationEffect(.degrees(isShown ? 90 : 0)).accessibilityHidden(true)
                }
                .lineLimit(1).truncationMode(.middle)
                .font(.system(size: ChatType.s(13), design: .monospaced))
                .padding(.leading, indent ? 30 : 12).padding(.trailing, 12)
                .frame(minHeight: 36)
                .background { Rectangle().fill(isShown ? Theme.C.muted.opacity(0.5) : .clear) }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(full)
            .accessibilityValue(isShown ? "diff shown" : "diff hidden")
            if isShown {
                FileDiffView(path: f.path, store: store)
            }
        }
    }

    static func color(_ s: ChangeStatus) -> Color {
        switch s {
        case .added, .untracked: Theme.C.okText
        case .modified: Theme.C.warnText
        case .renamed: Theme.C.link
        case .deleted: Theme.C.dangerText
        }
    }
}

/// "+12 −3"; a zero side is dimmed so the real change reads first.
private struct Stat: View {
    let added: Int
    let removed: Int
    var body: some View {
        (Text("+\(added)").foregroundColor(added > 0 ? Theme.C.okText : Theme.C.mutedForeground.opacity(0.6))
            + Text(" −\(removed)").foregroundColor(removed > 0 ? Theme.C.dangerText : Theme.C.mutedForeground.opacity(0.6)))
            .font(.system(size: ChatType.s(12), design: .monospaced)).monospacedDigit().fixedSize()
            .accessibilityLabel("\(added) added, \(removed) removed")
    }
}

/// One changed file's diff, fetched when opened: old and new line numbers, then the line. Long lines scroll sideways
/// inside the block; invisible and direction-changing characters show as muted escapes. The store hands the lines over
/// parsed and escaped; a long diff draws its first `shownMax` lines until asked for all.
struct FileDiffView: View {
    let path: String
    let store: ChangesStore
    @State private var diff: DiffView.Prepared?
    @State private var error: String?
    @State private var attempt = 0
    @State private var showAll = false
    /// The block's visible width: every row is at least this wide, so line backgrounds run edge to edge.
    @State private var visibleWidth: CGFloat = 0
    /// SF Mono at 12 pt.
    private static let charWidth: CGFloat = 7.23
    static let shownMax = 2000

    var body: some View {
        Group {
            if let error {
                HStack(spacing: 8) {
                    Text("Couldn't load the diff").accessibilityHint(error)
                    Button { attempt += 1 } label: { Label("Retry", systemImage: "arrow.clockwise") }.buttonStyle(.borderless)
                }
                .padding(.horizontal, 12).padding(.vertical, 8)
            } else if let diff {
                if diff.binary {
                    note("Binary file, no text diff")
                } else if diff.lines.isEmpty {
                    note("No line changes")
                } else {
                    table(diff)
                }
            } else {
                HStack(spacing: 8) { ProgressView().controlSize(.mini); Text("Loading diff…") }
                    .padding(.horizontal, 12).padding(.vertical, 8)
            }
        }
        .font(Theme.F.meta).foregroundStyle(Theme.C.mutedForeground)
        .task(id: attempt) {
            error = nil
            do { diff = try await store.diff(path) } catch is CancellationError {} catch { self.error = errorText(error) }
        }
    }

    private func note(_ s: String) -> some View {
        Text(s).padding(.horizontal, 12).padding(.vertical, 8)
    }

    private func table(_ d: DiffView.Prepared) -> some View {
        let shown = showAll ? d.lines[...] : d.lines.prefix(Self.shownMax)
        let numWidth = CGFloat(d.digits) * Self.charWidth
        // The longest line sets the scrolled width: numbers, sign, text and margins.
        let rowWidth = max(visibleWidth, 8 + 2 * (numWidth + 8) + 12 + CGFloat(d.longest) * Self.charWidth + 16)
        return VStack(alignment: .leading, spacing: 0) {
            ScrollView([.horizontal, .vertical]) {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(shown.indices, id: \.self) { i in row(d.lines[i], digits: d.digits).frame(width: rowWidth, alignment: .leading) }
                }
                .padding(.vertical, 4)
            }
            .plainScrollEdges()
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { visibleWidth = $0 }
            .frame(maxHeight: 448)
            .fixedSize(horizontal: false, vertical: true)
            if shown.count < d.lines.count {
                Button("Show all \(d.lines.count) lines") { showAll = true }
                    .font(.system(size: ChatType.s(13), weight: .medium)).buttonStyle(.borderless)
                    .padding(.horizontal, 12).frame(minHeight: 36)
            }
            if d.truncated { note("Diff truncated: the rest of this file's changes are not shown.") }
        }
        .background(Theme.C.background.opacity(0.6))
        .overlay(alignment: .top) { Rectangle().fill(Theme.C.border.opacity(0.6)).frame(height: 1 / 3) }
        .overlay(alignment: .bottom) { Rectangle().fill(Theme.C.border.opacity(0.6)).frame(height: 1 / 3) }
    }

    @ViewBuilder
    private func row(_ l: DiffView.Prepared.Line, digits: Int) -> some View {
        let mono = Font.system(size: ChatType.s(12), design: .monospaced)
        switch l.kind {
        case .hunk, .note:
            escapedText(l.parts).font(mono).italic(l.kind == .note).foregroundStyle(Theme.C.mutedForeground)
                .fixedSize().padding(.horizontal, 12).frame(minHeight: 20)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background { Rectangle().fill(l.kind == .hunk ? Theme.C.muted.opacity(0.6) : .clear) }
        case .add, .del, .ctx:
            HStack(spacing: 0) {
                // Line numbers are for reading: VoiceOver reads the change, not the numbers.
                Text(Self.number(l.old, width: digits)).fixedSize().padding(.trailing, 8)
                Text(Self.number(l.new, width: digits)).fixedSize().padding(.trailing, 8)
                Text(l.kind == .add ? "+" : l.kind == .del ? "−" : " ").frame(width: 12)
                    .foregroundStyle(Self.tint(l.kind))
                escapedText(l.parts).foregroundStyle(l.kind == .ctx ? Theme.C.foreground.opacity(0.8) : Self.tint(l.kind))
                    .fixedSize().padding(.trailing, 16)
                    .accessibilityLabel((l.kind == .add ? "added: " : l.kind == .del ? "removed: " : "") + l.text)
            }
            .font(mono).foregroundStyle(Theme.C.mutedForeground.opacity(0.7)).monospacedDigit()
            .padding(.leading, 8).frame(minHeight: 20)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background { Rectangle().fill(l.kind == .add ? Theme.C.ok.opacity(0.12) : l.kind == .del ? Theme.C.danger.opacity(0.10) : .clear) }
        }
    }

    /// A line number right-aligned in a fixed number of digits (the font is monospaced), blank where the side has none.
    private static func number(_ n: Int?, width: Int) -> String {
        let s = n.map(String.init) ?? ""
        return String(repeating: " ", count: max(0, width - s.count)) + s
    }

    private static func tint(_ k: DiffLine.Kind) -> Color {
        k == .add ? Theme.C.okText : k == .del ? Theme.C.dangerText : Theme.C.foreground
    }
}

/// Text with escapes muted, as one Text: diff lines, and file and folder names (a name can hold invisible or
/// direction-changing characters too).
func escapedText(_ parts: [DiffView.Part]) -> Text {
    parts.reduce(Text("")) { out, p in
        out + (p.escaped ? Text(p.text).foregroundColor(Theme.C.mutedForeground) : Text(p.text))
    }
}

func escapedText(_ s: String) -> Text { escapedText(DiffView.escapeInvisible(s)) }
