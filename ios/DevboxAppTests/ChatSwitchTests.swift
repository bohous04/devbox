import XCTest
@testable import DevboxApp

/// The chat switchers' rules (dashboard/src/switchView.ts): what can be picked and why not.
final class ChatSwitchTests: XCTestCase {
    private struct Tables: Decodable {
        struct Profile: Decodable, Equatable {
            let label: String, proxy: Bool, runtime: String, acp: String?, acpLive: Bool, chatOnly: Bool
        }
        let agentIds: [String]
        let profiles: [String: Profile]
        let chatModels: [String: [String]]
        let sameModelAliases: [String: String]
        let acpMinBridgeVersion: String
        let effortMinBridgeVersion: String
        let effortLevels: [String]
    }

    /// The tables are copies of the dashboard's and shared/'s; the JSON is checked against those by
    /// dashboard/src/chatTables.test.ts, so a change there that is not made here fails one of the two.
    func testTablesMatchTheSharedOnes() throws {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "chat-tables", withExtension: "json"))
        let t = try JSONDecoder().decode(Tables.self, from: Data(contentsOf: url))
        XCTAssertEqual(ChatSwitch.agentIds, t.agentIds)
        XCTAssertEqual(ChatSwitch.profiles.mapValues {
            Tables.Profile(label: $0.label, proxy: $0.proxy, runtime: $0.runtime, acp: $0.acp, acpLive: $0.acpLive, chatOnly: $0.chatOnly)
        }, t.profiles)
        XCTAssertEqual(ChatSwitch.chatModels, t.chatModels)
        XCTAssertEqual(ChatSwitch.sameModelAliases, t.sameModelAliases)
        XCTAssertEqual(ChatSwitch.acpMinBridgeVersion, t.acpMinBridgeVersion)
        XCTAssertEqual(ChatSwitch.effortMinBridgeVersion, t.effortMinBridgeVersion)
        XCTAssertEqual(Set(ChatSwitch.effortLabels.keys), Set(t.effortLevels))
    }

    private func target(agent: String = "claude", harness: String = "claude", account: String? = "a1", model: String? = "claude-opus-5-5",
                        awaiting: Bool = false, bridge: String? = "1.4.0", outdated: Bool? = nil) -> ChatTarget {
        ChatTarget(agent: agent, harness: harness, account: account, model: model, awaitingTarget: awaiting, bridgeVersion: bridge, bridgeOutdated: outdated)
    }

    /// dashboard/src/switchView.test.ts: the waiting line is re-read while it shows, and a failed re-read hides it.
    func testAwaitingTargetIsReReadAndHiddenWhenTheReReadFailed() {
        XCTAssertEqual(ChatSwitch.awaitingTargetText(target(awaiting: true)), "Agent is waiting for a target: pick a model, account or agent to continue")
        XCTAssertNil(ChatSwitch.awaitingTargetText(target(awaiting: true), stale: true))
        XCTAssertNil(ChatSwitch.awaitingTargetText(target(awaiting: false)))
        XCTAssertEqual(ChatSwitch.targetPollSeconds(target(awaiting: true)), 5)
        XCTAssertNil(ChatSwitch.targetPollSeconds(target(awaiting: false)))
    }

    func testOutdatedBridgeIsSaidWhileDevdSaysIt() {
        XCTAssertNil(ChatSwitch.bridgeOutdatedText(target(bridge: "1.8.0", outdated: false)))
        XCTAssertEqual(ChatSwitch.bridgeOutdatedText(target(bridge: "1.7.0", outdated: true)),
                       "This session's agent bridge (1.7.0) is outdated: recreate the session's container for the newer fixes.")
        XCTAssertEqual(ChatSwitch.bridgeOutdatedText(target(bridge: nil, outdated: true)),
                       "This session's agent bridge (older than 1.1.0) is outdated: recreate the session's container for the newer fixes.")
        // A devd from before the field: nothing said.
        XCTAssertNil(ChatSwitch.bridgeOutdatedText(target(bridge: "1.7.0")))
    }

    private func run(_ status: RunRow.Status, endedSeq: Int?) -> RunRow {
        RunRow(runId: "r", origin: .user, status: status, harness: nil, nativeThreadId: nil, model: nil, queuedAt: nil, startedAt: nil,
               endedAt: nil, endedSeq: endedSeq, usage: nil, error: nil, failureReason: nil)
    }

    func testSwitchBlockedWhileARunIsActiveOrQueuedUnlessAwaitingTarget() {
        XCTAssertEqual(ChatSwitch.blocked(runs: [run(.running, endedSeq: nil)], target: target()), "A run is active: stop it or wait for it to end, then switch")
        XCTAssertEqual(ChatSwitch.blocked(runs: [run(.queued, endedSeq: nil)], target: target()), "A message is queued: switch after it has run")
        XCTAssertNil(ChatSwitch.blocked(runs: [run(.completed, endedSeq: 4)], target: target()))
        XCTAssertNil(ChatSwitch.blocked(runs: [run(.running, endedSeq: nil)], target: target(awaiting: true)))
    }

    func testModelOptionsMarkTheCurrentModelAndAliases() {
        XCTAssertEqual(ChatSwitch.modelOptions(target()).map(\.value), ["claude-opus-5-5", "claude-sonnet-5-5"])
        XCTAssertEqual(ChatSwitch.modelOptions(target()).filter(\.current).map(\.value), ["claude-opus-5-5"])
        // An effort variant marks nothing: picking its base model is a real switch.
        XCTAssertEqual(ChatSwitch.modelOptions(target(model: "claude-opus-5-5-high")).filter(\.current).count, 0)
        XCTAssertEqual(ChatSwitch.modelOptions(target(agent: "vibe", harness: "vibe", model: "mistral-medium-latest")).filter(\.current).map(\.value), ["mistral-medium-3.5"])
        XCTAssertEqual(ChatSwitch.modelOptions(target(harness: "unknown")), [])
    }

    func testMenusBlockedForProxyProfilesAndAgentsWithoutAPool() {
        XCTAssertEqual(ChatSwitch.modelMenuBlocked(target(agent: "claude-openrouter")), "The model of Claude Code + OpenRouter is set in settings")
        XCTAssertNil(ChatSwitch.modelMenuBlocked(target()))
        XCTAssertEqual(ChatSwitch.accountMenuBlocked(target(agent: "vibe", harness: "vibe")), "Mistral Vibe runs on no account pool")
        XCTAssertNil(ChatSwitch.accountMenuBlocked(target(agent: "codex", harness: "codex")))
    }

    func testHarnessOptionsDisableWhatChatCannotRunAndAcpOnAnOldBridge() {
        let opts = ChatSwitch.harnessOptions(target())
        XCTAssertEqual(opts.map(\.value), ["claude", "claude-gemini", "claude-openrouter", "codex", "grok", "antigravity", "vibe"])
        XCTAssertNil(opts.first { $0.value == "grok" }?.disabled)
        XCTAssertEqual(opts.first { $0.value == "antigravity" }?.disabled, "Antigravity is not available in chat sessions yet")
        XCTAssertNil(opts.first { $0.value == "vibe" }?.disabled)
        XCTAssertTrue(opts.first { $0.value == "claude" }!.current)
        let old = ChatSwitch.harnessOptions(target(bridge: "1.1.0"))
        XCTAssertEqual(old.first { $0.value == "vibe" }?.disabled, "recreate the container to use Mistral Vibe")
        XCTAssertNil(old.first { $0.value == "codex" }?.disabled)
    }

    func testVersionAtLeast() {
        XCTAssertTrue(ChatSwitch.versionAtLeast("1.2.0", "1.2.0"))
        XCTAssertTrue(ChatSwitch.versionAtLeast("1.10.0", "1.2.0"))
        XCTAssertFalse(ChatSwitch.versionAtLeast("1.1.9", "1.2.0"))
        XCTAssertFalse(ChatSwitch.versionAtLeast("dev", "1.2.0"))
    }

    func testErrorAndResultTexts() {
        XCTAssertEqual(ChatSwitch.errorText(DevdHTTPError(statusCode: 409, serverMessage: "run-active")), "A run is active or a message is queued: switch after it ends")
        XCTAssertEqual(ChatSwitch.errorText(DevdHTTPError(statusCode: 504, serverMessage: "agent-timeout")), "No reply from the agent: the switch may have happened, check the thread before retrying")
        XCTAssertEqual(ChatSwitch.errorText(DevdHTTPError(statusCode: 409, serverMessage: "bridge-too-old", serverDetail: "recreate the container")), "recreate the container (bridge-too-old)")
        XCTAssertEqual(ChatSwitch.errorText(DevdHTTPError(statusCode: 400, serverMessage: "unknown-model")), "unknown-model")
        XCTAssertEqual(ChatSwitch.resultText(ChatSwitchResult(kind: "set-model", unchanged: true, exhausted: nil)), "Already on that: nothing was switched")
        XCTAssertEqual(ChatSwitch.resultText(ChatSwitchResult(kind: "restart-resume", unchanged: nil, exhausted: true)), "Switched, but the account is over its usage limit")
        XCTAssertNil(ChatSwitch.resultText(ChatSwitchResult(kind: "set-model", unchanged: nil, exhausted: nil)))
    }

    func testClaudeAccountOptions() throws {
        let json = #"""
        {"accounts":[
          {"id":"a1","label":"One","disabled":false,"quarantined":false,"fiveHourPct":95,"fiveHourResetsAt":9999999999999,"sevenDayPct":10,"sevenDayResetsAt":null,"limits":[],"fetchedAt":1,"error":null,"errorCount":0,"orgId":null,"observedOrgId":null,"leases":[]},
          {"id":"a2","label":"Two","disabled":false,"quarantined":true,"fiveHourPct":null,"fiveHourResetsAt":null,"sevenDayPct":null,"sevenDayResetsAt":null,"limits":[],"fetchedAt":1,"error":null,"errorCount":0,"orgId":null,"observedOrgId":null,"leases":[]},
          {"id":"a3","label":"Three","disabled":false,"quarantined":false,"fiveHourPct":null,"fiveHourResetsAt":null,"sevenDayPct":null,"sevenDayResetsAt":null,"limits":[],"fetchedAt":1,"error":"HTTP 401","errorCount":3,"orgId":null,"observedOrgId":null,"leases":[]}
        ],"pool":{"thresholdPct":90,"spilloverPct":80,"preferredAccountId":null,"projectAccounts":{},"soloAccountId":null}}
        """#
        let r = try JSONDecoder().decode(AccountsResponse.self, from: Data(json.utf8))
        let o = ChatSwitch.claudeAccountOptions(r.accounts, thresholdPct: r.pool.thresholdPct, now: 1000, target: target())
        XCTAssertEqual(o.map(\.detail), ["5h 95% · 7d 10%", "5h — · 7d —", "5h — · 7d —"])
        XCTAssertEqual(o[0].warning, "over limit (95%)")
        XCTAssertTrue(o[0].current)
        XCTAssertEqual(o[1].disabled, "Quarantined: sign in again on the Auth page")
        XCTAssertEqual(o[2].disabled, "Login expired or unusable (HTTP 401)")
    }

    // MARK: effort (bridge 1.7.0, dashboard/src/switchView.ts)

    private func effort(model: String? = "claude-opus-5-5", supported: [String]? = ["low", "medium", "high", "xhigh", "max"],
                        effective: String? = nil, chosen: String? = nil) -> ThreadEffort {
        ThreadEffort(model: model, supported: supported, effective: effective, chosen: chosen)
    }

    func testEffortChip() {
        let new = target(bridge: "1.7.0")
        XCTAssertEqual(ChatSwitch.effortChipLabel(effort(effective: "high", chosen: "max"), new), "High")
        XCTAssertEqual(ChatSwitch.effortChipLabel(effort(chosen: "xhigh"), new), "Extra high")
        XCTAssertEqual(ChatSwitch.effortChipLabel(effort(), new), "Default")
        XCTAssertNil(ChatSwitch.effortChipLabel(effort(supported: []), new))
        XCTAssertNil(ChatSwitch.effortChipLabel(nil, new))
        XCTAssertNil(ChatSwitch.effortChipLabel(effort(chosen: "high"), target(bridge: "1.6.0")))
    }

    func testEffortMenu() {
        let o = ChatSwitch.effortOptions(effort(effective: "high", chosen: "high"))
        XCTAssertEqual(o.map(\.value), ["", "low", "medium", "high", "xhigh", "max"])
        XCTAssertEqual(o.map(\.label), ["Default", "Low", "Medium", "High", "Extra high", "Max"])
        XCTAssertEqual(o.filter(\.current).map(\.value), ["high"])
        XCTAssertEqual(ChatSwitch.effortOptions(effort()).filter(\.current).map(\.value), [""])
        XCTAssertEqual(ChatSwitch.effortOptions(effort(model: "gpt-6.1-sol", supported: ["low", "medium"], effective: "medium"))[0].detail, "Medium for gpt-6.1-sol")
        XCTAssertEqual(ChatSwitch.effortOptions(effort())[0].detail, "The level shows after the agent's first reply")
    }

    func testEffortBodySendsNullForDefault() throws {
        XCTAssertEqual(String(decoding: try JSONEncoder().encode(ChatSwitch.EffortBody(effort: nil)), as: UTF8.self), #"{"effort":null}"#)
        XCTAssertEqual(String(decoding: try JSONEncoder().encode(ChatSwitch.EffortBody(effort: "high")), as: UTF8.self), #"{"effort":"high"}"#)
    }

    func testEffortMenuBlocked() {
        XCTAssertEqual(ChatSwitch.effortMenuBlocked(effort(), target(bridge: "1.6.0")), "This session's agent bridge (1.6.0) cannot change the effort: recreate the session's container")
        XCTAssertEqual(ChatSwitch.effortMenuBlocked(effort(), target(bridge: nil)), "This session's agent bridge (unknown version) cannot change the effort: recreate the session's container")
        let new = target(bridge: "1.7.0")
        XCTAssertEqual(ChatSwitch.effortMenuBlocked(nil, new), "The agent has not reported its effort levels yet")
        XCTAssertEqual(ChatSwitch.effortMenuBlocked(effort(supported: nil), new), "The agent has not reported the effort levels of claude-opus-5-5")
        XCTAssertEqual(ChatSwitch.effortMenuBlocked(effort(supported: []), new), "claude-opus-5-5 has no effort levels")
        XCTAssertNil(ChatSwitch.effortMenuBlocked(effort(), new))
    }

    func testEffortBeforeTheModelsLevelsAreKnown() {
        let new = target(bridge: "1.8.0")
        let early = ThreadEffort(model: nil, supported: nil, effective: nil, chosen: "xhigh", unchecked: ["low", "medium", "high", "xhigh", "max"])
        XCTAssertNil(ChatSwitch.effortMenuBlocked(early, new))
        XCTAssertEqual(ChatSwitch.effortOptions(early).map(\.value), ["", "low", "medium", "high", "xhigh", "max"])
        XCTAssertEqual(ChatSwitch.effortOptions(early).filter(\.current).map(\.value), ["xhigh"])
        XCTAssertEqual(ChatSwitch.effortChipLabel(early, new), "Extra high")
        XCTAssertEqual(ChatSwitch.effortFooter(early), "Checked against the model on your next message.")
        XCTAssertEqual(ChatSwitch.effortFooter(effort()), "Applies from your next message.")
        // A model named while its levels are still unknown: its list could not check them.
        var named = early
        named.model = "claude-haiku-9"
        XCTAssertEqual(ChatSwitch.effortFooter(named), "Applies from your next message; claude-haiku-9's levels could not be read, so it is not checked.")
    }
}
