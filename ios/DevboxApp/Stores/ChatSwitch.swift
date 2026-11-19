import Foundation

/// The chat switchers' rules: a port of `dashboard/src/switchView.ts` (with the parts of `newSession.ts`,
/// `shared/chatModels.ts` and `shared/bridgeVersion.ts` it reads). devd decides (chatSwitch.ts); these mirror its
/// rules so the menus do not offer what it would refuse, and say why.
enum ChatSwitch {
    struct Option: Equatable, Identifiable {
        let value: String
        let label: String
        /// Second line, e.g. usage.
        var detail: String?
        let current: Bool
        /// Why it cannot be picked; nil = it can.
        var disabled: String?
        /// Can be picked, but the user should know (an account over its limit).
        var warning: String?
        var id: String { value }
    }

    /// What chat needs to know of a profile (`AGENT_PROFILES` in dashboard/src/newSession.ts).
    struct Profile {
        let label: String
        let proxy: Bool
        /// claude, codex, grok, agy or vibe.
        let runtime: String
        let acp: String?
        let acpLive: Bool
        /// Has no tmux launcher (devd tmuxRuntimeBlock).
        var chatOnly = false
    }

    /// `AGENT_IDS` order.
    static let agentIds = ["claude", "claude-gemini", "claude-openrouter", "codex", "grok", "antigravity", "vibe"]
    static let profiles: [String: Profile] = [
        "claude": Profile(label: "Claude Code", proxy: false, runtime: "claude", acp: nil, acpLive: false),
        "claude-gemini": Profile(label: "Claude Code + Gemini", proxy: true, runtime: "claude", acp: nil, acpLive: false),
        "claude-openrouter": Profile(label: "Claude Code + OpenRouter", proxy: true, runtime: "claude", acp: nil, acpLive: false),
        "codex": Profile(label: "Codex", proxy: false, runtime: "codex", acp: nil, acpLive: false),
        "grok": Profile(label: "Grok Build", proxy: false, runtime: "grok", acp: "grok", acpLive: false),
        "antigravity": Profile(label: "Antigravity", proxy: false, runtime: "agy", acp: "antigravity", acpLive: false),
        "vibe": Profile(label: "Mistral Vibe", proxy: false, runtime: "vibe", acp: "vibe", acpLive: true, chatOnly: true),
    ]

    /// `agentNameFor`: an unknown profile reads as claude (as devd and the dashboard do), so the UI never breaks.
    static func profile(_ agent: String) -> Profile { profiles[agent] ?? profiles["claude"]! }

    /// `shared/chatModels.ts` CHAT_MODELS and SAME_MODEL_ALIASES.
    static let chatModels: [String: [String]] = [
        "claude": ["claude-opus-5-5", "claude-sonnet-5-5"],
        "codex": ["gpt-6.1-sol", "gpt-6-sol", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4-mini", "gpt-5.3-codex"],
        "grok": ["grok-4.6", "grok-4.5"],
        "vibe": ["mistral-large-4-0", "mistral-medium-3.5"],
        "antigravity": ["gemini-4-neon"],
    ]
    static let sameModelAliases = ["mistral-medium-latest": "mistral-medium-3.5"]
    /// `ACP_MIN_BRIDGE_VERSION`.
    static let acpMinBridgeVersion = "1.2.0"

    /// `version` (`x.y.z`) is `min` or newer; anything that is not `x.y.z` counts as older.
    static func versionAtLeast(_ version: String, _ min: String) -> Bool {
        func parse(_ v: String) -> [Int]? {
            let p = v.split(separator: ".", omittingEmptySubsequences: false).map { Int($0) }
            return p.count == 3 && p.allSatisfy { $0 != nil } ? p.map { $0! } : nil
        }
        guard let a = parse(version), let b = parse(min) else { return false }
        for i in 0..<3 where a[i] != b[i] { return a[i] > b[i] }
        return true
    }

    /// `chatRuntimeBlock(agent, "vps")`: the chat bridge runs Claude and Codex (the proxy profiles run Claude Code)
    /// and the ACP agents that passed their live check.
    static func chatRuntimeBlock(_ agent: String) -> String? {
        let p = profile(agent)
        let harness = p.runtime == "claude" || p.runtime == "codex" ? p.runtime : p.acp
        if harness == nil || (p.acp != nil && !p.acpLive) { return "\(p.label) is not available in chat sessions yet" }
        return nil
    }

    /// devd refuses a switch with 409 run-active while a run is active or a message is queued; not while the bridge
    /// awaits its target (the queued messages wait for exactly that).
    static func blocked(runs: [RunRow], target: ChatTarget) -> String? {
        if target.awaitingTarget { return nil }
        if runs.contains(where: { $0.status == .running }) { return "A run is active: stop it or wait for it to end, then switch" }
        if runs.contains(where: { $0.endedSeq == nil }) { return "A message is queued: switch after it has run" }
        return nil
    }

    static func awaitingTargetText(_ t: ChatTarget) -> String? {
        t.awaitingTarget ? "Agent is waiting for a target: pick a model, account or agent to continue" : nil
    }

    /// A proxy profile's model is set in settings (devd: 400 model-set-by-profile).
    static func modelMenuBlocked(_ t: ChatTarget) -> String? {
        let p = profile(t.agent)
        return p.proxy ? "The model of \(p.label) is set in settings" : nil
    }

    /// The models devd accepts for the harness; a reported alias marks the model it runs, a variant marks nothing.
    static func modelOptions(_ t: ChatTarget) -> [Option] {
        let current = t.model.map { sameModelAliases[$0] ?? $0 }
        return (chatModels[t.harness] ?? []).map { Option(value: $0, label: $0, current: $0 == current) }
    }

    /// devd: 400 no-account-pool. Proxy profiles and ACP agents (their own CLI login) have no account pool.
    static func accountMenuBlocked(_ t: ChatTarget) -> String? {
        let p = profile(t.agent)
        return p.proxy || (p.runtime != "claude" && p.runtime != "codex") ? "\(p.label) runs on no account pool" : nil
    }

    private static func pct(_ v: Double?) -> String { v.map { "\(Int($0.rounded()))%" } ?? "—" }

    /// devd accountPolicy windowOver: over the threshold and not reset yet (an unknown reset counts as not yet).
    private static func over(_ p: Double?, _ resetsAt: Int?, now: Int, threshold: Double) -> Bool {
        guard let p else { return false }
        return p >= threshold && (resetsAt.map { $0 > now } ?? true)
    }

    /// Claude pool accounts: quarantined, disabled and permanently unmeasured cannot be picked; one over the
    /// threshold can, with a warning.
    static func claudeAccountOptions(_ accounts: [AccountView], thresholdPct: Double, now: Int, target t: ChatTarget) -> [Option] {
        accounts.map { a in
            let disabled: String? = a.quarantined ? "Quarantined: sign in again on the Auth page"
                : a.disabled ? "Disabled"
                : a.error != nil && a.fiveHourPct == nil && a.sevenDayPct == nil ? "Login expired or unusable (\(a.error!))"
                : nil
            let overPct = [(a.fiveHourPct, a.fiveHourResetsAt), (a.sevenDayPct, a.sevenDayResetsAt)]
                .filter { over($0.0, $0.1, now: now, threshold: thresholdPct) }.compactMap(\.0)
            return Option(value: a.id, label: a.label, detail: "5h \(pct(a.fiveHourPct)) · 7d \(pct(a.sevenDayPct))", current: a.id == t.account,
                          disabled: disabled, warning: overPct.max().map { "over limit (\(pct($0)))" })
        }
    }

    /// Codex accounts: disabled, signed out or a rejected login cannot be picked; a reached limit whose window has
    /// not reset can, with a warning.
    static func codexAccountOptions(_ accounts: [CodexAccountView], now: Int, target t: ChatTarget) -> [Option] {
        accounts.map { a in
            let u = a.usage
            let rejected = u?.state == .error && (u?.error ?? "").range(of: #"HTTP (401|402|403)|deactivated|invalid_grant"#, options: [.regularExpression, .caseInsensitive]) != nil
            let disabled: String? = a.disabled ? "Disabled"
                : u?.state == .signedOut ? "Signed out: sign in on the Subscriptions page"
                : rejected ? "Login rejected (\(u?.error ?? ""))"
                : nil
            let measured = u?.windows.filter { $0.usedPct != nil } ?? []
            let notReset = measured.filter { $0.resetsAt.map { $0 > now } ?? true }
            let reached = !(u?.limitReached ?? "").isEmpty
            let live = reached && (measured.isEmpty || !notReset.isEmpty)
            let livePct = notReset.compactMap(\.usedPct).max()
            return Option(value: a.id, label: a.label,
                          detail: measured.isEmpty ? nil : measured.map { "\(SubscriptionsStore.codexWindowLabel($0.windowMinutes)) \(pct($0.usedPct))" }.joined(separator: " · "),
                          current: a.id == t.account, disabled: disabled,
                          warning: live ? (livePct.map { "over limit (\(pct($0)))" } ?? "over limit") : nil)
        }
    }

    /// Every profile; the ones chat cannot run disabled with devd's reason, an ACP agent on an old bridge too.
    static func harnessOptions(_ t: ChatTarget) -> [Option] {
        let oldBridge = t.bridgeVersion.map { !versionAtLeast($0, acpMinBridgeVersion) } ?? false
        return agentIds.map { id in
            let p = profile(id)
            // devd: 409 bridge-too-old, same text.
            let disabled = chatRuntimeBlock(id) ?? (oldBridge && p.acp != nil ? "recreate the container to use \(p.label)" : nil)
            return Option(value: id, label: p.label, current: id == t.agent, disabled: disabled)
        }
    }

    /// What the switchers show when devd refused or the bridge did not confirm; the code stays visible.
    static func errorText(_ error: Error) -> String {
        guard let h = error as? DevdHTTPError, let code = h.serverMessage else { return errorText(fallback: error) }
        switch code {
        case "run-active": return "A run is active or a message is queued: switch after it ends"
        case "switch-in-progress": return "Another switch is already in progress"
        case "agent-disconnected": return "Agent not connected: nothing was switched"
        case "agent-timeout": return "No reply from the agent: the switch may have happened, check the thread before retrying"
        default: return h.serverDetail.map { "\($0) (\(code))" } ?? code
        }
    }

    private static func errorText(fallback error: Error) -> String { DevboxApp.errorText(error) }

    /// A confirmed switch says itself in the thread (devd's notice); this is only what the notice does not say.
    static func resultText(_ r: ChatSwitchResult) -> String? {
        if r.unchanged == true { return r.exhausted == true ? "Already on that account; it is over its usage limit" : "Already on that: nothing was switched" }
        if r.exhausted == true { return "Switched, but the account is over its usage limit" }
        return nil
    }
}
