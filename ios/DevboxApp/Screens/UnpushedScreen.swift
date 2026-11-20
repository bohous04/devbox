import SwiftUI

/// Unpushed commits, mirrors `dashboard/src/pages/Unpushed.tsx` (see `UnpushedStore`): by folder, then repo, then
/// branch, with the branch's commits folded away until asked for. Push and Create PR are the web's actions with the
/// web's steps: Push runs on the click, Create PR opens a form with an editable title first.
struct UnpushedScreen: View {
    @StateObject private var store: UnpushedStore
    @State private var expanded: Set<String> = []
    @State private var busy: String?
    @State private var actionError: [String: String] = [:]
    @State private var prDraft: PrDraft?

    init(client: DevdClient) {
        _store = StateObject(wrappedValue: UnpushedStore(client: client))
    }

    struct PrDraft: Identifiable {
        let repo: UnpushedRepo
        let branch: UnpushedBranch
        var id: String { Self.key(repo, branch) }
        static func key(_ repo: UnpushedRepo, _ branch: UnpushedBranch) -> String { "\(repo.path)#\(branch.branch)" }
    }

    var body: some View {
        List {
            if let error = store.error {
                Section { Text("Failed to load: \(error)").font(.caption).foregroundStyle(Theme.C.dangerText) }
            }
            if let error = store.status?.error {
                Section { Text("Last scan failed: \(error)").font(.caption).foregroundStyle(Theme.C.dangerText) }
            }
            if let notice = store.notice {
                Section { noticeRow(notice) }
            }
            content
        }
        .insetGroupedList()
        .themedListBackground()
        .navigationTitle("Unpushed")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { Task { await store.load(fresh: true) } } label: { Label("Rescan", systemImage: "arrow.clockwise") }
                    .help("Scan every repository again")
            }
        }
        .task { await store.load() }
        .onDisappear { store.stop() }
        .refreshable { await store.load(fresh: true) }
        .sheet(item: $prDraft) { draft in
            CreatePrSheet(repo: draft.repo, branch: draft.branch) { title in
                try await store.createPr(draft.repo, draft.branch, title: title)
            }
        }
    }

    @ViewBuilder
    private var content: some View {
        if let report = store.report {
            Section {
                summary(report)
            } footer: {
                Text("Commits that exist only on this machine, newest first. Uncommitted changes are not counted.")
            }
            if report.folders.isEmpty {
                Section { EmptyState("Everything is pushed. All \(report.scanned) repositories have their commits on a remote.", systemImage: "checkmark.circle") }
            }
            ForEach(report.folders, id: \.folder) { folder in
                Section {
                    ForEach(folder.repos, id: \.path) { repo in
                        repoRow(repo)
                        ForEach(repo.branches, id: \.branch) { branch in branchRow(repo, branch) }
                    }
                } header: {
                    HStack {
                        Text("\(folder.folder)/").font(.system(.subheadline, design: .monospaced).weight(.semibold))
                        Text("\(folder.repos.count) \(folder.repos.count == 1 ? "repo" : "repos")")
                        Spacer()
                        Text(UnpushedStore.commitsLabel(folder.count)).monospacedDigit()
                    }
                    .textCase(nil)
                }
            }
        } else {
            Section {
                HStack(spacing: 10) {
                    ProgressView().controlSize(.small)
                    Text(store.status?.scanning == true ? "Scanning repositories for the first time…" : "Loading…")
                        .font(.subheadline).foregroundStyle(Theme.C.mutedForeground)
                }
            }
        }
    }

    private func summary(_ report: UnpushedReport) -> some View {
        let folders = "\(report.folders.count) \(report.folders.count == 1 ? "folder" : "folders")"
        let ago = Format.agoLabel(Date().timeIntervalSince1970 * 1000 - Double(report.at))
        return HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text("\(report.total)").font(.system(.title3, design: .monospaced).weight(.semibold))
            Text("unpushed \(report.total == 1 ? "commit" : "commits") across \(folders) · \(report.scanned) repos scanned · \(ago)"
                 + (store.status?.scanning == true ? " · rescanning…" : ""))
                .font(.caption).foregroundStyle(Theme.C.mutedForeground)
        }
    }

    private func noticeRow(_ notice: UnpushedStore.Notice) -> some View {
        HStack(spacing: 8) {
            StatusDot(.ok)
            Text(notice.text).font(.subheadline)
            Spacer(minLength: 8)
            if let url = notice.url {
                Link(destination: url) { Label("Open", systemImage: "arrow.up.right.square") }.font(.subheadline)
            }
            Button("Dismiss") { store.notice = nil }.buttonStyle(.borderless).font(.subheadline)
        }
    }

    private func repoRow(_ repo: UnpushedRepo) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                StatusDot(repo.error == nil ? .warn : .danger)
                Text(UnpushedStore.repoTitle(repo)).font(.system(.subheadline, design: .monospaced).weight(.semibold))
                ForEach(UnpushedStore.repoFlags(repo), id: \.self) { Badge($0.uppercased(), variant: .outline) }
                Text(UnpushedStore.commitsLabel(repo.count)).font(.caption).foregroundStyle(Theme.C.mutedForeground)
                Spacer(minLength: 8)
                Text(repo.path).font(.system(.caption2, design: .monospaced)).foregroundStyle(Theme.C.mutedForeground)
                    .lineLimit(1).truncationMode(.head)
            }
            if let error = repo.error {
                Text("git failed here: \(error)").font(.caption).foregroundStyle(Theme.C.dangerText)
            }
            if repo.detailsSkipped == true {
                Text("Too many unpushed commits to break down by branch; only the total is counted.")
                    .font(.caption).foregroundStyle(Theme.C.mutedForeground)
            }
        }
    }

    private func branchRow(_ repo: UnpushedRepo, _ branch: UnpushedBranch) -> some View {
        let key = PrDraft.key(repo, branch)
        let open = expanded.contains(key)
        return VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Button {
                    if open { expanded.remove(key) } else { expanded.insert(key) }
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "chevron.right").font(.caption2.weight(.semibold))
                            .rotationEffect(.degrees(open ? 90 : 0)).foregroundStyle(Theme.C.mutedForeground)
                        Text(UnpushedStore.branchLabel(branch)).font(.system(.caption, design: .monospaced).weight(.semibold))
                            .lineLimit(1).truncationMode(.middle)
                        Text(UnpushedStore.commitsLabel(branch.count, shown: branch.truncated ? branch.commits.count : nil))
                            .font(.caption).foregroundStyle(Theme.C.mutedForeground)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityValue(open ? "expanded" : "collapsed")
                Spacer(minLength: 8)
                if UnpushedStore.canPush(repo) {
                    Button("Push") { push(repo, branch) }
                        .buttonStyle(.bordered).controlSize(.small)
                }
                if UnpushedStore.canCreatePr(repo) {
                    Button("Create PR") { prDraft = PrDraft(repo: repo, branch: branch) }
                        .buttonStyle(.bordered).controlSize(.small)
                }
            }
            .disabled(busy == key)
            if let error = actionError[key] {
                Text(error).font(.caption).foregroundStyle(Theme.C.dangerText)
            }
            if open {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(branch.commits, id: \.hash) { commitRow($0) }
                }
                .padding(.leading, 18)
            }
        }
        .padding(.leading, 16)
    }

    private func commitRow(_ c: UnpushedCommit) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text(UnpushedStore.shortHash(c.hash)).font(.system(.caption, design: .monospaced)).foregroundStyle(Theme.C.mutedForeground)
            Text(c.subject).font(.subheadline).lineLimit(1)
            Spacer(minLength: 8)
            if c.at > 0 {
                Text(Format.agoLabel(Date().timeIntervalSince1970 * 1000 - Double(c.at)))
                    .font(.caption).foregroundStyle(Theme.C.mutedForeground).help(c.author)
            }
        }
    }

    private func push(_ repo: UnpushedRepo, _ branch: UnpushedBranch) {
        let key = PrDraft.key(repo, branch)
        busy = key
        actionError[key] = nil
        Task {
            do { try await store.push(repo, branch) } catch { actionError[key] = errorText(error) }
            busy = nil
        }
    }
}

/// The web's inline Create PR form: the target, an editable title (the body is the commit list), then one button
/// that pushes the branch and opens the pull request.
private struct CreatePrSheet: View {
    let repo: UnpushedRepo
    let branch: UnpushedBranch
    let create: (String) async throws -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var title: String
    @State private var error: String?
    @State private var busy = false

    init(repo: UnpushedRepo, branch: UnpushedBranch, create: @escaping (String) async throws -> Void) {
        self.repo = repo
        self.branch = branch
        self.create = create
        _title = State(initialValue: UnpushedStore.prTitle(branch))
    }

    private var target: String {
        let host = repo.remote?.provider == "github" ? "GitHub" : "Gitea"
        return "\(branch.branch) → \(repo.base ?? "main") on \(host) · \(repo.remote?.owner ?? "")/\(repo.remote?.name ?? "")"
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Pull request title", text: $title)
                        .onSubmit(submit)
                } header: {
                    Text(target).textCase(nil)
                } footer: {
                    Text("Body: \(UnpushedStore.commitsLabel(branch.count)) listed as bullet points.")
                }
                if let error {
                    Section { Text(error).font(.caption).foregroundStyle(Theme.C.dangerText) }
                }
            }
            .navigationTitle("Create pull request")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Push + create PR", action: submit).disabled(busy)
                }
            }
        }
        #if os(macOS)
        .frame(minWidth: 420, minHeight: 220)
        #endif
    }

    private func submit() {
        let t = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { error = "Title is required."; return }
        guard !busy else { return }
        busy = true
        error = nil
        Task {
            do {
                try await create(t)
                dismiss()
            } catch {
                self.error = errorText(error)
            }
            busy = false
        }
    }
}
