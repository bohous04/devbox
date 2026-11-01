import XCTest
@testable import DevboxApp

/// Pure `FoldersStore` functions — the app is READ-ONLY (no config editor), so unlike the web
/// everything is derived from the tree (`/api/tree`), not from the configuration.
final class FoldersStoreTests: XCTestCase {
    private func repo(_ name: String, cloned: Bool, provider: String = "github", bare: Bool? = nil, agent: AgentName? = nil) -> TreeRepo {
        TreeRepo(name: name, cloneUrl: "https://x/\(name).git", provider: provider, cloned: cloned, bare: bare, agent: agent)
    }

    private func project(_ folder: String, _ project: String, _ repos: [TreeRepo]) -> TreeProject {
        TreeProject(folder: folder, project: project, repos: repos, soloAgent: nil)
    }

    // MARK: - folderNames

    func testFolderNamesAreUniqueAndSorted() {
        let tree = [project("b", "p1", []), project("a", "p2", []), project("b", "p3", [])]
        XCTAssertEqual(FoldersStore.folderNames(tree), ["a", "b"])
    }

    func testFolderNamesOnEmptyTreeIsEmpty() {
        XCTAssertEqual(FoldersStore.folderNames([]), [])
    }

    // MARK: - projects

    func testProjectsFiltersByFolderAndSortsByName() {
        let tree = [project("a", "z", []), project("a", "m", []), project("b", "x", [])]
        let result = FoldersStore.projects(tree, folder: "a")
        XCTAssertEqual(result.map(\.project), ["m", "z"])
    }

    // MARK: - clonedCount

    func testClonedCountCountsOnlyClonedRepos() {
        let p = project("a", "p", [repo("r1", cloned: true), repo("r2", cloned: false), repo("r3", cloned: true)])
        let (cloned, total) = FoldersStore.clonedCount(p)
        XCTAssertEqual(cloned, 2)
        XCTAssertEqual(total, 3)
    }

    func testClonedCountOnEmptyRepos() {
        let (cloned, total) = FoldersStore.clonedCount(project("a", "p", []))
        XCTAssertEqual(cloned, 0)
        XCTAssertEqual(total, 0)
    }

    // MARK: - folderClonedCount

    func testFolderClonedCountSumsAcrossProjects() {
        let tree = [
            project("a", "p1", [repo("r1", cloned: true), repo("r2", cloned: false)]),
            project("a", "p2", [repo("r3", cloned: true)]),
            project("b", "p3", [repo("r4", cloned: false)]),
        ]
        let (cloned, total) = FoldersStore.folderClonedCount(tree, folder: "a")
        XCTAssertEqual(cloned, 2)
        XCTAssertEqual(total, 3)
    }

    func testFolderClonedCountForUnknownFolderIsZero() {
        let (cloned, total) = FoldersStore.folderClonedCount([project("a", "p", [repo("r", cloned: true)])], folder: "missing")
        XCTAssertEqual(cloned, 0)
        XCTAssertEqual(total, 0)
    }
}
