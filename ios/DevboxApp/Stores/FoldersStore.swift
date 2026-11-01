import Foundation

/// View-model for `FoldersScreen` — reads `/api/tree`. READ-ONLY (deliberate narrowing of stage G, see the task
/// report): the app only DISPLAYS the tree — no adding/removing of repos/sources/projects/folders, no
/// GitHub/Gitea browser, no clone jobs. A config editor + repo browser is extra surface on a phone
/// and the use case is rare; any follow-up belongs to the web. Fetch-on-appear + pull-to-refresh, no
/// polling (the tree changes only after a manual action on the web/a clone).
@MainActor
final class FoldersStore: ObservableObject {
    @Published private(set) var tree: [TreeProject]?
    @Published private(set) var error: String?

    private let client: DevdClient

    init(client: DevdClient) {
        self.client = client
    }

    func load() async {
        do {
            tree = try await client.get("/api/tree")
            error = nil
        } catch {
            self.error = errorText(error)
        }
    }

    // MARK: - Pure

    /// Unique folder names, alphabetical — the app (unlike the web) derives them from the tree, not
    /// from the config (the app does not read the config).
    nonisolated static func folderNames(_ tree: [TreeProject]) -> [String] {
        Array(Set(tree.map(\.folder))).sorted()
    }

    /// Projects of one folder, sorted by name.
    nonisolated static func projects(_ tree: [TreeProject], folder: String) -> [TreeProject] {
        tree.filter { $0.folder == folder }.sorted { $0.project < $1.project }
    }

    /// How many repos of one project are cloned — numerator/denominator of `X/Y cloned` on the row.
    nonisolated static func clonedCount(_ project: TreeProject) -> (cloned: Int, total: Int) {
        (project.repos.filter(\.cloned).count, project.repos.count)
    }

    /// Sum over all projects of one folder — section header.
    nonisolated static func folderClonedCount(_ tree: [TreeProject], folder: String) -> (cloned: Int, total: Int) {
        let rows = projects(tree, folder: folder)
        return (
            rows.reduce(0) { $0 + clonedCount($1).cloned },
            rows.reduce(0) { $0 + $1.repos.count }
        )
    }

}
