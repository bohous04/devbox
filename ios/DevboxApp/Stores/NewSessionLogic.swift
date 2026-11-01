import Foundation

/// Pure functions of the "New session" cascade — 1:1 port of `dashboard/src/newSession.ts` (without `recents`,
/// same as the dashboard). `AGENT_PROFILES`/`AGENT_IDS`/`agentNameFor`/`profileFor` from that
/// file are already mirrored in `AgentProfiles` (SessionActions.swift) — here only the
/// Folder→Project→Repo→Agent cascade and helper queries over `[TreeProject]`/`[SessionLive]`.
enum NewSessionLogic {
    /// Special repo value for "no repo, just a scratch workspace" — mirrors `SOLO` from
    /// newSession.ts. It is not a real repo name, just a sentinel in the Repo picker.
    static let SOLO = "claudeSolo"

    /// Mirrors `RepoChoice` from newSession.ts. Keeps `bare` as `Bool?` (not a default `false`),
    /// same as TS `bare?: boolean` — an older devd does not send the field and the UI must be able to tell that apart from
    /// "I know for sure it is NOT bare".
    struct RepoChoice: Equatable {
        let value: String
        let label: String
        let cloned: Bool
        let bare: Bool?
        let cloneUrl: String?
    }

    static func folderChoices(_ tree: [TreeProject]) -> [String] {
        Array(Set(tree.map(\.folder))).sorted()
    }

    static func projectChoices(_ tree: [TreeProject], folder: String) -> [String] {
        tree.filter { $0.folder == folder }.map(\.project).sorted()
    }

    /// A flat folder (repos directly under the folder) is collapsed in the tree into one project named
    /// after the folder — and in general any folder with a single project turns the "Project" step into extra
    /// friction on mobile. The sheet auto-fills it based on this. Mirrors `soleProject` from newSession.ts.
    static func soleProject(_ tree: [TreeProject], folder: String) -> String? {
        let ps = projectChoices(tree, folder: folder)
        return ps.count == 1 ? ps.first : nil
    }

    /// Mirrors `repoChoices` from newSession.ts — sorted repos (label with a "(cloned)" suffix) plus
    /// `SOLO` added at the end (it is always available, even for an empty project).
    static func repoChoices(_ tree: [TreeProject], folder: String, project: String) -> [RepoChoice] {
        let proj = tree.first { $0.folder == folder && $0.project == project }
        let repos = (proj?.repos ?? [])
            .map { r in
                RepoChoice(
                    value: r.name,
                    label: r.cloned ? "\(r.name) (cloned)" : r.name,
                    cloned: r.cloned,
                    bare: r.bare,
                    cloneUrl: r.cloneUrl
                )
            }
            .sorted { $0.value < $1.value }
        return repos + [RepoChoice(value: SOLO, label: SOLO, cloned: false, bare: nil, cloneUrl: nil)]
    }

    /// Default agent for a repo = the remembered choice from the tree (`repo_prefs`/`soloAgent`), otherwise
    /// claude. Mirrors `defaultAgentFor` from newSession.ts, BUT additionally goes through
    /// `AgentProfiles.normalize` — `TreeRepo.agent`/`TreeProject.soloAgent` decodes an unknown
    /// value from the server to `.unknown` (see `AgentName.init(from:)` in Models.swift), and without
    /// normalization it would leak into the Agent picker as an untagged option. The web does not have this risk (its field
    /// is just a string, not a tolerant enum).
    static func defaultAgentFor(_ tree: [TreeProject], folder: String, project: String, repo: String) -> AgentName {
        guard let proj = tree.first(where: { $0.folder == folder && $0.project == project }) else { return .claude }
        if repo == SOLO {
            return AgentProfiles.normalize(proj.soloAgent)
        }
        return AgentProfiles.normalize(proj.repos.first(where: { $0.name == repo })?.agent)
    }

    /// Sessions that exist over this repo — the state is deliberately NOT filtered (a stopped session
    /// still occupies the id/ports/worktree, "Open" starts it back up). Mirrors `sessionsFor` from
    /// newSession.ts; generic over `RepoKeyed`, so it can (like the TS version) be tested outside
    /// `SessionLive` too.
    static func sessionsFor<T: RepoKeyed>(_ sessions: [T], project: String, repo: String) -> [T] {
        sessions.filter { $0.project == project && $0.repo == repo }
            .sorted { $0.id < $1.id }
    }
}

/// Minimal shape that `sessionsFor` needs from one session — `SessionLive` satisfies it
/// structurally (same field names/types), see the conformance below.
protocol RepoKeyed {
    var project: String { get }
    var repo: String { get }
    var id: String { get }
}

extension SessionLive: RepoKeyed {}
