import SwiftUI

/// "New session" sheet — mirrors the `NewSession` component from `dashboard/src/pages/Sessions.tsx`:
/// cascade Folder → Project → Repo → Agent (auto-fill of `soleProject` and `defaultAgentFor` when
/// picking a repo), then Open/Start (+ "New session", only when the repo already has a session). Pure functions are
/// in `NewSessionLogic.swift`, the network calls in `SessionActions.tree/openSession/openSolo`.
///
/// Unlike the web (where `NewSession` stays permanently mounted and fetches the tree only once
/// per page lifetime) this sheet refetches the tree on EVERY open — SwiftUI `.sheet`
/// creates a new view instance on each presentation, so `@State` would not persist anyway, and
/// a fresh tree is desirable besides (a repo may have been added via the Folders tab in the meantime).
struct NewSessionSheet: View {
    @EnvironmentObject private var store: LiveStore
    @Environment(\.dismiss) private var dismiss
    let actions: SessionActions
    let onStarted: () async -> Void

    @State private var tree: [TreeProject]?
    @State private var folder = ""
    @State private var project = ""
    @State private var repo = ""
    @State private var agent: AgentName = .claude
    @State private var msg: String?
    @State private var err: String?
    @State private var busy = false

    private var folders: [String] {
        tree.map(NewSessionLogic.folderChoices) ?? []
    }

    private var projects: [String] {
        guard let tree, !folder.isEmpty else { return [] }
        return NewSessionLogic.projectChoices(tree, folder: folder)
    }

    private var repos: [NewSessionLogic.RepoChoice] {
        guard let tree, !folder.isEmpty, !project.isEmpty else { return [] }
        return NewSessionLogic.repoChoices(tree, folder: folder, project: project)
    }

    private var selected: NewSessionLogic.RepoChoice? {
        repos.first { $0.value == repo }
    }

    /// Solo has no repo of its own and the server does not accept `fresh` for it (`openSolo`) — "New session"
    /// therefore makes sense only for a real repo, same as on the web.
    private var existing: [SessionLive] {
        guard !repo.isEmpty, repo != NewSessionLogic.SOLO else { return [] }
        return NewSessionLogic.sessionsFor(store.live?.sessions ?? [], project: project, repo: repo)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("Folder", selection: $folder) {
                        Text("—").tag("")
                        ForEach(folders, id: \.self) { Text($0).tag($0) }
                    }
                    .disabled(tree == nil)
                    .onChange(of: folder) { _, newFolder in
                        project = ""
                        repo = ""
                        // A folder with a single project (flat folder) → fill it in ourselves so the user on
                        // mobile sees the repo choice right away instead of a confusing empty intermediate step.
                        if let tree, let sp = NewSessionLogic.soleProject(tree, folder: newFolder) {
                            project = sp
                        }
                    }

                    Picker("Project", selection: $project) {
                        Text("—").tag("")
                        ForEach(projects, id: \.self) { Text($0).tag($0) }
                    }
                    .disabled(folder.isEmpty)
                    .onChange(of: project) { _, _ in repo = "" }

                    Picker("Repo", selection: $repo) {
                        Text("—").tag("")
                        ForEach(repos, id: \.value) { Text($0.label).tag($0.value) }
                    }
                    .disabled(project.isEmpty)
                    .onChange(of: repo) { _, newRepo in
                        agent = NewSessionLogic.defaultAgentFor(tree ?? [], folder: folder, project: project, repo: newRepo)
                    }

                    Picker("Agent", selection: $agent) {
                        ForEach(AgentProfiles.ids, id: \.self) { id in
                            let profile = AgentProfiles.profile(for: id)
                            Text(profile.label + (profile.yolo ? " (yolo)" : "")).tag(id)
                        }
                    }
                    .disabled(repo.isEmpty)
                }

                Section {
                    Button(existing.isEmpty ? "Start" : "Open") { start(fresh: nil) }
                        .disabled(repo.isEmpty || busy)
                    if !existing.isEmpty {
                        Button("New session") { start(fresh: true) }
                            .disabled(repo.isEmpty || busy)
                    }
                    // A repo in the old layout (shared working directory) cannot give another session its own
                    // worktree or branch — only its own container. Two agents over one git index
                    // must be told up front, not discovered from the behavior.
                    if !existing.isEmpty, let selected, selected.cloned, selected.bare != true {
                        Text("New session shares this repo's working directory and branch (own container, same files).")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    if let msg {
                        Text(msg)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    if let err {
                        Text("Error: \(err)")
                            .font(.caption)
                            .foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("New session")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
            .task { await loadTree() }
        }
    }

    // MARK: - Private

    private func loadTree() async {
        guard tree == nil else { return }
        do {
            tree = try await actions.tree()
        } catch {
            err = errorText(error)
        }
    }

    private func start(fresh: Bool?) {
        guard !folder.isEmpty, !project.isEmpty, !repo.isEmpty, !busy else { return }
        err = nil
        msg = nil
        busy = true
        let choice = selected
        let capturedFolder = folder, capturedProject = project, capturedRepo = repo, capturedAgent = agent
        Task {
            do {
                let result: OpenResult
                if capturedRepo == NewSessionLogic.SOLO {
                    result = try await actions.openSolo(folder: capturedFolder, project: capturedProject, agent: capturedAgent)
                } else {
                    result = try await actions.openSession(
                        folder: capturedFolder, project: capturedProject, repo: capturedRepo,
                        cloneUrl: choice?.cloneUrl, agent: capturedAgent, fresh: fresh
                    )
                }
                msg = result.pull?.status == "conflict"
                    ? "\(result.session.id) is running — pull conflict, the agent is resolving it now"
                    : "Session \(result.session.id) running."
                repo = ""
                await onStarted()
            } catch {
                err = errorText(error)
            }
            busy = false
        }
    }
}
