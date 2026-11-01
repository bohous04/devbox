import XCTest
@testable import DevboxApp

/// Port of the scenarios from `dashboard/src/newSession.test.ts` (same fixture, same assertions) —
/// `AGENT_IDS`/`AGENT_PROFILES` parity with devd is tested only on the TS side there (importing devd/src/agents.ts
/// does not work across languages); the Swift mirror `AgentProfiles` has its own tests in `SessionActionsTests`.
final class NewSessionLogicTests: XCTestCase {
    private let tree: [TreeProject] = [
        TreeProject(folder: "acme", project: "shop", repos: [
            TreeRepo(name: "web", cloneUrl: "https://x/web.git", provider: "github", cloned: false, bare: nil, agent: nil),
            TreeRepo(name: "cms", cloneUrl: "https://x/cms.git", provider: "github", cloned: true, bare: nil, agent: nil),
        ], soloAgent: nil),
        TreeProject(folder: "acme", project: "infra", repos: [], soloAgent: nil),
        TreeProject(folder: "games", project: "games", repos: [
            TreeRepo(name: "core", cloneUrl: "https://x/c.git", provider: "gitea", cloned: false, bare: nil, agent: nil),
        ], soloAgent: nil),
    ]

    // MARK: - folderChoices / projectChoices

    func testFolderChoicesUniqueAndSorted() {
        XCTAssertEqual(NewSessionLogic.folderChoices(tree), ["acme", "games"])
    }

    func testProjectChoicesFiltersByFolder() {
        XCTAssertEqual(NewSessionLogic.projectChoices(tree, folder: "acme"), ["infra", "shop"])
        XCTAssertEqual(NewSessionLogic.projectChoices(tree, folder: "games"), ["games"])
    }

    // MARK: - repoChoices

    func testRepoChoicesSortsMarksClonedRepoAndEndsWithSolo() {
        let r = NewSessionLogic.repoChoices(tree, folder: "acme", project: "shop")
        XCTAssertEqual(r.map(\.value), ["cms", "web", NewSessionLogic.SOLO])
        XCTAssertEqual(r[0].label, "cms (cloned)")
        XCTAssertEqual(r[1].label, "web")
        XCTAssertEqual(r[1].cloneUrl, "https://x/web.git")
        XCTAssertEqual(r.last?.value, NewSessionLogic.SOLO)
    }

    /// I3 from the review: "New session" on a repo in the OLD shape (shared working directory) gives its own
    /// container, but the same files and the same branch — two agents on one git index. The `bare`
    /// flag is carried over from the tree so the UI can say so instead of doing it silently.
    func testRepoChoicesCarriesBareShape() {
        let t = [TreeProject(folder: "acme", project: "shop", repos: [
            TreeRepo(name: "novy", cloneUrl: "https://x/n.git", provider: "github", cloned: true, bare: true, agent: nil),
            TreeRepo(name: "stary", cloneUrl: "https://x/s.git", provider: "github", cloned: true, bare: nil, agent: nil),
        ], soloAgent: nil)]
        let r = NewSessionLogic.repoChoices(t, folder: "acme", project: "shop")
        XCTAssertEqual(r.first { $0.value == "novy" }?.bare, true)
        XCTAssertNil(r.first { $0.value == "stary" }?.bare)
    }

    func testRepoChoicesOnEmptyProjectStillOffersSolo() {
        XCTAssertEqual(NewSessionLogic.repoChoices(tree, folder: "acme", project: "infra").map(\.value), [NewSessionLogic.SOLO])
    }

    // MARK: - soleProject

    func testSoleProjectReturnsSingleProjectFlatFolderOtherwiseNil() {
        XCTAssertEqual(NewSessionLogic.soleProject(tree, folder: "games"), "games") // flat folder = 1 projekt → auto
        XCTAssertNil(NewSessionLogic.soleProject(tree, folder: "acme"))          // several projects → the user picks
        XCTAssertNil(NewSessionLogic.soleProject(tree, folder: "neexistuje"))
    }

    // MARK: - defaultAgentFor

    private let agentTree: [TreeProject] = [
        TreeProject(folder: "acme", project: "shop", repos: [
            TreeRepo(name: "app", cloneUrl: "u", provider: "github", cloned: true, bare: nil, agent: .codex),
            TreeRepo(name: "web", cloneUrl: "u", provider: "github", cloned: true, bare: nil, agent: nil),
        ], soloAgent: .codex),
    ]

    func testDefaultAgentForRememberedChoiceSoloAndFallback() {
        XCTAssertEqual(NewSessionLogic.defaultAgentFor(agentTree, folder: "acme", project: "shop", repo: "app"), .codex)
        XCTAssertEqual(NewSessionLogic.defaultAgentFor(agentTree, folder: "acme", project: "shop", repo: "web"), .claude)
        XCTAssertEqual(NewSessionLogic.defaultAgentFor(agentTree, folder: "acme", project: "shop", repo: NewSessionLogic.SOLO), .codex)
        XCTAssertEqual(NewSessionLogic.defaultAgentFor(agentTree, folder: "acme", project: "shop", repo: "neznamy"), .claude)
        XCTAssertEqual(NewSessionLogic.defaultAgentFor([], folder: "", project: "", repo: ""), .claude)
    }

    /// Extension over the TS version: an unknown value from a newer devd decodes to `.unknown`
    /// (`AgentName.init(from:)`), not to `nil` — `defaultAgentFor` must map it via `AgentProfiles.normalize`
    /// to `.claude` just like a missing value, otherwise it would leak into the picker
    /// as an untagged option.
    func testDefaultAgentForNormalizesUnknownDecodedAgent() {
        let t = [TreeProject(folder: "acme", project: "shop", repos: [
            TreeRepo(name: "app", cloneUrl: "u", provider: "github", cloned: true, bare: nil, agent: .unknown),
        ], soloAgent: .unknown)]
        XCTAssertEqual(NewSessionLogic.defaultAgentFor(t, folder: "acme", project: "shop", repo: "app"), .claude)
        XCTAssertEqual(NewSessionLogic.defaultAgentFor(t, folder: "acme", project: "shop", repo: NewSessionLogic.SOLO), .claude)
    }

    // MARK: - sessionsFor

    private struct FakeSession: RepoKeyed {
        let id: String
        let project: String
        let repo: String
    }

    func testSessionsForCountsSessionsPerRepo() {
        let sessions = [
            FakeSession(id: "dev-portal-web", project: "portal", repo: "web"),
            FakeSession(id: "dev-portal-web-2", project: "portal", repo: "web"),
            FakeSession(id: "dev-portal-api", project: "portal", repo: "api"),
        ]
        XCTAssertEqual(NewSessionLogic.sessionsFor(sessions, project: "portal", repo: "web").count, 2)
        XCTAssertEqual(NewSessionLogic.sessionsFor(sessions, project: "portal", repo: "api").count, 1)
        XCTAssertEqual(NewSessionLogic.sessionsFor(sessions, project: "portal", repo: "nic").count, 0)
    }
}
