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
        "grok": Profile(label: "Grok Build", proxy: false, runtime: "grok", acp: "grok", acpLive: true),
        "antigravity": Profile(label: "Antigravity", proxy: false, runtime: "agy", acp: "antigravity", acpLive: false),
        "vibe": Profile(label: "Mistral Vibe", proxy: false, runtime: "vibe", acp: "vibe", acpLive: true, chatOnly: true),
    ]

    /// `agentNameFor`: an unknown profile reads as claude (as devd and the dashboard do), so the UI never breaks.
    static func profile(_ agent: String) -> Profile { profiles[agent] ?? profiles["claude"]! }

    /// `shared/chatModels.ts` CHAT_MODELS and SAME_MODEL_ALIASES.
    static let chatModels: [String: [String]] = [
        "claude": ["claude-opus-5-5", "claude-sonnet-5-5"],
        "codex": ["gpt-6.1-sol", "gpt-6-sol", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4-mini", "gpt-5.3-codex"],
        "grok": ["grok-4.7", "grok-4.7-build-fast", "grok-4.6", "grok-4.5"],
        "vibe": ["mistral-large-4-0", "mistral-medium-3.5"],
        "antigravity": ["gemini-4-neon"],
    ]
    static let sameModelAliases = ["mistral-medium-latest": "mistral-medium-3.5"]
    /// `ACP_MIN_BRIDGE_VERSION`.
    static let acpMinBridgeVersion = "1.2.0"
    /// `EFFORT_MIN_BRIDGE_VERSION`: older bridges neither report nor take an effort (devd: 409 bridge-too-old).
    static let effortMinBridgeVersion = "1.7.0"

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

    /// devd's `bridgeOutdated`, said beside the menus while true (switchView.ts bridgeOutdatedText): it was a thread
    /// notice that went stale once the bridge was updated.
    static func bridgeOutdatedText(_ t: ChatTarget) -> String? {
        t.bridgeOutdated == true ? "This session's agent bridge (\(t.bridgeVersion ?? "older than 1.1.0")) is outdated: recreate the session's container for the newer fixes." : nil
    }

    /// Shown while the bridge awaits its target: picking any model, account or agent (also the current one) sends it.
    /// Not from a `stale` target (its latest re-read failed): devd keeps re-sending on its own and may have delivered it.
    static func awaitingTargetText(_ t: ChatTarget, stale: Bool = false) -> String? {
        t.awaitingTarget && !stale ? "Agent is waiting for a target: pick a model, account or agent to continue" : nil
    }

    /// devd settles an awaited target by re-sending it in the background, which the thread may not show (no new native
    /// thread, no run): while the agent waits, the target is re-read this often so the waiting line goes away
    /// (dashboard/src/switchView.ts targetPollMs).
    static func targetPollSeconds(_ t: ChatTarget) -> Double? {
        t.awaitingTarget ? 5 : nil
    }

    /// Orders the target reads (dashboard/src/switchView.ts TargetReader): only the newest read lands, so an older
    /// `awaitingTarget: true` never overwrites a newer false; a poll skips its tick while a read is in flight.
    struct LatestRead {
        private var seq = 0
        private var inFlight = 0
        var busy: Bool { inFlight > 0 }

        mutating func begin() -> Int {
            seq += 1
            inFlight += 1
            return seq
        }

        /// Whether read `n`'s answer lands (no read started after it).
        mutating func end(_ n: Int) -> Bool {
            inFlight -= 1
            return n == seq
        }
    }

    /// A proxy profile's model is set in settings (devd: 400 model-set-by-profile).
    static func modelMenuBlocked(_ t: ChatTarget) -> String? {
        let p = profile(t.agent)
        return p.proxy ? "The model of \(p.label) is set in settings" : nil
    }

    private static let familyPrefix: [String: String?] = ["claude": nil, "gpt": "GPT-", "grok": "Grok ", "mistral": "Mistral ", "gemini": "Gemini "]

    /// Display name of a model id for the composer chip ("claude-opus-5-5-high" → "Opus 5.5 High";
    /// dashboard/src/switchView.ts modelLabel). Display only: switches and devd keep the id. An id of an unknown family
    /// or shape stays the raw id, so nothing is guessed.
    static func modelLabel(_ id: String) -> String {
        let resolved = (sameModelAliases[id] ?? id).replacingOccurrences(of: #"-(\d{8}|\d{4}-\d{2}-\d{2})$"#, with: "", options: .regularExpression)
        let tokens = resolved.components(separatedBy: "-")
        guard let family = tokens.first, let prefix = familyPrefix[family], tokens.count > 1,
              tokens.dropFirst().allSatisfy({ $0.range(of: #"^[a-z0-9.]+$"#, options: .regularExpression) != nil }) else { return id }
        func digits(_ s: String) -> Bool { !s.isEmpty && s.allSatisfy(\.isNumber) }
        // Version parts split by dashes ("5-5") join with dots; words are capitalised.
        var parts: [String] = []
        for t in tokens.dropFirst() {
            if digits(t), let prev = parts.last, digits(prev) { parts[parts.count - 1] = "\(prev).\(t)" } else { parts.append(t) }
        }
        func cap(_ w: String) -> String { w.prefix(1).uppercased() + w.dropFirst() }
        guard let prefix else { return parts.map(cap).joined(separator: " ") }
        if prefix == "GPT-" { return (["GPT-\(parts[0])"] + parts.dropFirst().map(cap)).joined(separator: " ") }
        return prefix + parts.map(cap).joined(separator: " ")
    }

    /// The model's family for the iPhone's one-row chip ("Opus", "GPT-6.1"): the first word of `modelLabel`, or the
    /// whole id when it is not one devbox names.
    static func shortModelLabel(_ id: String) -> String {
        let label = modelLabel(id)
        guard label != id else { return id }
        return label.components(separatedBy: " ").first ?? label
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

    /// Every level devd accepts (shared/effort.ts KNOWN_EFFORT_LEVELS), with its name.
    static let effortLabels = ["none": "None", "minimal": "Minimal", "low": "Low", "medium": "Medium", "high": "High",
                                       "xhigh": "Extra high", "max": "Max", "ultra": "Ultra"]
    /// A level as the agent names it; one this list does not know shows as reported (switchView.ts effortLabel).
    static func effortLabel(_ level: String) -> String { effortLabels[level] ?? level }

    private static func effortBridge(_ t: ChatTarget) -> Bool {
        t.bridgeVersion.map { versionAtLeast($0, effortMinBridgeVersion) } ?? false
    }

    /// The chip's level ("Opus 5.5 · High"): the level the agent reported running at, else the choice not yet run, else
    /// "Default" (Claude says its level only with a reply). nil = no level part: an agent without levels, levels not
    /// reported yet, or a bridge that cannot report them.
    static func effortChipLabel(_ e: ThreadEffort?, _ t: ChatTarget) -> String? {
        guard effortBridge(t), let e, e.supported?.isEmpty != true else { return nil }
        return (e.effective ?? e.chosen).map(effortLabel) ?? "Default"
    }

    /// Why the Effort menu cannot be used. Not blocked by a run: the level applies from the next message.
    static func effortMenuBlocked(_ e: ThreadEffort?, _ t: ChatTarget) -> String? {
        if !effortBridge(t) { return "This session's agent bridge (\(t.bridgeVersion ?? "unknown version")) cannot change the effort: recreate the session's container" }
        guard let e else { return "The agent has not reported its effort levels yet" }
        // Before the model names its levels the bridge (1.8.0) may take unchecked ones (effortFooter says when they are checked).
        if e.supported == nil, e.unchecked != nil { return nil }
        guard let supported = e.supported else { return "The agent has not reported the effort levels of \(e.model ?? "this model")" }
        if supported.isEmpty { return "\(e.model ?? "This model") has no effort levels" }
        return nil
    }

    /// POST thread/effort's body. `{"effort": null}` goes back to the model default: the key must be sent, so null is
    /// encoded, not left out.
    struct EffortBody: Encodable {
        let effort: String?
        private enum K: String, CodingKey { case effort }
        func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: K.self)
            try c.encode(effort, forKey: .effort)
        }
    }

    /// "Default" (value "": the model's own level, sent as null) and the levels the model lists, or before it does, the
    /// unchecked ones the agent takes.
    static func effortOptions(_ e: ThreadEffort) -> [Option] {
        let detail: String? = e.chosen != nil ? nil
            : e.effective.map { "\(effortLabel($0)) for \(e.model ?? "this model")" } ?? "The level shows after the agent's first reply"
        return [Option(value: "", label: "Default", detail: detail, current: e.chosen == nil)]
            + (e.supported ?? e.unchecked ?? []).map { Option(value: $0, label: effortLabel($0), current: e.chosen == $0) }
    }

    /// The line under the Effort menu (switchView.ts effortFooter): when a pick applies, and for unchecked levels, that
    /// the next message checks it (a level the model lacks goes back to its default, said in the thread), or, once a
    /// model is named and its levels are still unknown, that its list could not check it.
    static func effortFooter(_ e: ThreadEffort?) -> String {
        guard let e, e.supported == nil, e.unchecked != nil else { return "Applies from your next message." }
        guard let model = e.model else { return "Checked against the model on your next message." }
        return "Applies from your next message; \(model)'s levels could not be read, so it is not checked."
    }

    /// What the switchers show when devd refused or the bridge did not confirm; the code stays visible.
    static func errorText(_ error: Error) -> String {
        guard let h = error as? DevdHTTPError, let code = h.serverMessage else { return errorText(fallback: error) }
        switch code {
        case "run-active": return "A run is active or a message is queued: switch after it ends"
        case "switch-in-progress": return "Another switch is already in progress"
        case "switch-unconfirmed": return "The last switch is not confirmed by the agent yet: wait a moment and check the thread"
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
