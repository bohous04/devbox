import SwiftUI

/// Folders screen — mirrors `dashboard/src/pages/Folders.tsx`, NARROWED to a READ-ONLY view of the
/// tree (see `FoldersStore` for fetch/pure helpers). The app cannot add/delete a repo/source/
/// project/folder, browse GitHub/Gitea or start clone jobs — on a phone that is extra surface
/// and a rare use case (deliberate narrowing, see task report; any follow-up belongs on the web).
struct FoldersScreen: View {
    @StateObject private var store: FoldersStore

    init(client: DevdClient) {
        _store = StateObject(wrappedValue: FoldersStore(client: client))
    }

    var body: some View {
        Group {
            if let tree = store.tree {
                List {
                    if tree.isEmpty {
                        Section {
                            Text("No folders yet — add one on the dashboard.")
                                .font(.subheadline)
                                .foregroundStyle(Theme.C.mutedForeground)
                        }
                    } else {
                        ForEach(FoldersStore.folderNames(tree), id: \.self) { folder in
                            folderSection(tree, folder: folder)
                        }
                    }
                }
                .listStyle(.insetGrouped)
            } else if let error = store.error {
                ContentUnavailableView(
                    "Couldn't load folders",
                    systemImage: "folder.badge.questionmark",
                    description: Text(error)
                )
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .themedListBackground()
        .navigationTitle("Folders")
        .task { await store.load() }
        .refreshable { await store.load() }
    }

    @ViewBuilder
    private func folderSection(_ tree: [TreeProject], folder: String) -> some View {
        let projects = FoldersStore.projects(tree, folder: folder)
        let (cloned, total) = FoldersStore.folderClonedCount(tree, folder: folder)
        Section {
            ForEach(projects, id: \.project) { project in
                projectRow(project)
            }
        } header: {
            Text("\(folder)/")
        } footer: {
            Text("\(cloned)/\(total) cloned")
        }
    }

    @ViewBuilder
    private func projectRow(_ project: TreeProject) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(project.project).font(.subheadline.weight(.semibold))
                Spacer()
                let (cloned, total) = FoldersStore.clonedCount(project)
                Text("\(cloned)/\(total)").font(.caption.monospacedDigit()).foregroundStyle(Theme.C.mutedForeground)
            }
            ForEach(project.repos, id: \.name) { repo in
                repoRow(repo)
            }
        }
        .padding(.vertical, 2)
    }

    private func repoRow(_ repo: TreeRepo) -> some View {
        HStack(spacing: 6) {
            Circle()
                .fill(repo.cloned ? Theme.C.ok : Theme.C.idle)
                .frame(width: 6, height: 6)
            Text(repo.name).font(.caption).lineLimit(1)
            if repo.provider != "github" {
                Text(repo.provider).font(.system(size: 9)).foregroundStyle(Theme.C.mutedForeground)
            }
            if repo.bare == true {
                Text("bare").font(.system(size: 9, weight: .semibold)).foregroundStyle(Theme.C.mutedForeground)
            }
            Spacer()
            if let agent = repo.agent, agent != .unknown {
                Badge(AgentProfiles.profile(for: agent).short, variant: .secondary)
            }
        }
    }
}
