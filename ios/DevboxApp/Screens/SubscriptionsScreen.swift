import SwiftUI

/// AI subscriptions screen — mirrors `dashboard/src/pages/Subscriptions.tsx`. Disable/Enable of an
/// Anthropic account (H0 fix pack) is wired up; preferred/replace-credentials/per-account switch are
/// DELIBERATELY web-only — see ruling H0 in the `SubscriptionsStore` doc (config-wide footgun, the session-scoped
/// switch account the app already has elsewhere, replace credentials is a half-typed JSON blob outside mobile scope).
/// Fetch-on-appear + pull-to-refresh, no polling. `TimelineView` only ticks a local clock for the
/// countdowns to reset (`resetCountdown`/`measuredLabel`), it triggers no network by itself.
struct SubscriptionsScreen: View {
    @StateObject private var store: SubscriptionsStore
    /// `busyId`/`actionError` — same pattern as `CronScreen`/`ProdWritesScreen`: per-row busy
    /// state keyed by `AccountView.id`, the error is shown under the section instead of the button swallowing it silently.
    @State private var busyId: String?
    @State private var actionError: String?

    init(client: DevdClient) {
        _store = StateObject(wrappedValue: SubscriptionsStore(client: client))
    }

    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { context in
            ScreenScroll {
                if !store.accountsPoolOff {
                    VStack(alignment: .leading, spacing: 8) {
                        SectionHeader("Anthropic accounts")
                        anthropicContent(now: context.date)
                        if let actionError {
                            Text(actionError).font(Theme.F.meta).foregroundStyle(Theme.C.dangerText)
                        }
                    }
                }
                if store.codex.visible {
                    VStack(alignment: .leading, spacing: 8) {
                        SectionHeader("Codex")
                        codexContent(now: context.date)
                    }
                }
                if store.grok.visible {
                    VStack(alignment: .leading, spacing: 8) {
                        SectionHeader("Grok")
                        grokContent(now: context.date)
                    }
                }
                if !store.openrouterAbsent {
                    VStack(alignment: .leading, spacing: 8) {
                        SectionHeader("OpenRouter")
                        OpenrouterCardView(view: store.openrouter)
                    }
                }
            }
        }
        .navigationTitle("AI limits & accounts")
        .task { await store.load() }
        .refreshable { await store.load() }
    }

    private func toggleDisabled(_ account: AccountView) {
        busyId = account.id
        actionError = nil
        Task {
            do { try await store.setDisabled(account, disabled: !account.disabled) }
            catch { actionError = errorText(error) }
            busyId = nil
        }
    }

    // MARK: - Anthropic accounts

    @ViewBuilder
    private func anthropicContent(now: Date) -> some View {
        if let error = store.accountsError {
            Text(error).font(Theme.F.meta).foregroundStyle(Theme.C.dangerText)
        }
        if let accounts = store.accounts {
            if accounts.isEmpty {
                EmptyState("No accounts yet — sessions use the shared profile.", systemImage: "person.2")
            } else {
                ForEach(accounts, id: \.id) { account in
                    AccountCardView(
                        account: account,
                        pool: store.pool,
                        now: now,
                        isBusy: busyId == account.id,
                        onToggleDisabled: { toggleDisabled(account) }
                    )
                }
            }
        } else if store.accountsError == nil {
            Card { ProgressView().frame(maxWidth: .infinity) }
        }
    }

    // MARK: - Codex / Grok

    @ViewBuilder
    private func codexContent(now: Date) -> some View {
        if let fetchErr = store.codex.fetchErr {
            Text("Couldn't reach devd for the Codex quota: \(fetchErr)")
                .font(Theme.F.meta)
                .foregroundStyle(Theme.C.mutedForeground)
        }
        if case .value(let codex) = store.codex.phase, let codex {
            CodexCardView(codex: codex, now: now)
        } else if store.codex.fetchErr == nil {
            Card { ProgressView().frame(maxWidth: .infinity) }
        }
    }

    @ViewBuilder
    private func grokContent(now: Date) -> some View {
        if let fetchErr = store.grok.fetchErr {
            Text("Couldn't reach devd for the Grok quota: \(fetchErr)")
                .font(Theme.F.meta)
                .foregroundStyle(Theme.C.mutedForeground)
        }
        if case .value(let grok) = store.grok.phase, let grok {
            GrokCardView(grok: grok, now: now)
        } else if store.grok.fetchErr == nil {
            Card { ProgressView().frame(maxWidth: .infinity) }
        }
    }
}

// MARK: - Anthropic account card

private struct AccountCardView: View {
    let account: AccountView
    let pool: AccountPoolView?
    let now: Date
    let isBusy: Bool
    let onToggleDisabled: () -> Void

    var body: some View {
        let split = SubscriptionsStore.splitTierLabel(account.label)
        let threshold = pool?.thresholdPct ?? SubscriptionsStore.defaultThresholdPct
        let status = SubscriptionsStore.accountStatus(account, thresholdPct: threshold)
        let role = pool.flatMap { SubscriptionsStore.poolRole(account, $0, now: now) }
        let pins = pool.map { SubscriptionsStore.pinnedProjects(account.id, $0) } ?? []
        let models = SubscriptionsStore.modelRows(account)
        let errorView = SubscriptionsStore.usageErrorView(account.error, account.errorCount)

        Card {
            VStack(alignment: .leading, spacing: 12) {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 4) {
                        // `.top`, not the default `.center` — the account name (e-mail) can be long and with
                        // large Dynamic Type it wraps to several lines; without `.top` the badge would
                        // be centered in the middle of the wrapped text instead of at its first line.
                        HStack(alignment: .top, spacing: 6) {
                            Text(split.name).font(Theme.F.body.weight(.semibold))
                            if let tier = split.tier {
                                Badge(tier, variant: .outline)
                            }
                        }
                        HStack(spacing: 4) {
                            Text(account.id)
                                .font(.system(size: 11, design: .monospaced))
                                .foregroundStyle(Theme.C.mutedForeground)
                            if let role {
                                Text("· \(SubscriptionsStore.poolRoleLabel[role] ?? "")")
                                    .font(.system(size: 11, weight: role == .backup ? .regular : .semibold))
                                    .foregroundStyle(role == .backup ? Theme.C.mutedForeground : Theme.C.foreground)
                            }
                        }
                        // A separate row, not a continuation of the HStack above — the project list can be longer
                        // than the rest of the meta row and has nowhere to wrap on the card (the web has flex-wrap).
                        if !pins.isEmpty {
                            Text("· PINNED: \(pins.joined(separator: ", "))")
                                .font(.system(size: 11, weight: .semibold))
                                .foregroundStyle(Theme.C.foreground)
                        }
                    }
                    Spacer()
                    VStack(alignment: .trailing, spacing: 4) {
                        Badge(status.text, variant: badgeVariant(status.tone))
                        Text(SubscriptionsStore.measuredLabel(account.fetchedAt, now: now))
                            .font(Theme.F.meta)
                            .foregroundStyle(Theme.C.mutedForeground)
                    }
                }

                if let errorView {
                    Text(errorView.text)
                        .font(Theme.F.meta)
                        .foregroundStyle(errorView.transient ? Theme.C.mutedForeground : Theme.C.dangerText)
                }

                QuotaBar(
                    label: "5-hour window",
                    pct: account.fiveHourPct.map { $0 / 100 },
                    caption: SubscriptionsStore.resetCountdown(account.fiveHourResetsAt, now: now)
                )
                QuotaBar(
                    label: "Weekly allowance",
                    pct: account.sevenDayPct.map { $0 / 100 },
                    caption: SubscriptionsStore.resetCountdown(account.sevenDayResetsAt, now: now)
                )

                if !models.isEmpty {
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(models, id: \.model) { row in
                            HStack {
                                Text(row.model).font(Theme.F.meta).foregroundStyle(Theme.C.mutedForeground)
                                Spacer()
                                Text(row.percent.map { "\(Int($0.rounded()))%" } ?? "—")
                                    .font(.system(size: 12, design: .monospaced))
                            }
                        }
                    }
                }

                Text("Running: \(SubscriptionsStore.leaseSummary(account))")
                    .font(Theme.F.meta)
                    .foregroundStyle(Theme.C.mutedForeground)

                if account.quarantined {
                    Text("Log in again on your Mac and re-add this account.")
                        .font(Theme.F.meta)
                        .foregroundStyle(Theme.C.dangerText)
                }

                HStack {
                    Spacer()
                    if isBusy {
                        ProgressView().controlSize(.small)
                    }
                    Button(account.disabled ? "Enable" : "Disable", action: onToggleDisabled)
                        .buttonStyle(DevboxButtonStyle(variant: .outline))
                }
                .disabled(isBusy)
            }
        }
    }
}

// MARK: - Codex card

private struct CodexCardView: View {
    let codex: CodexSubscriptionView
    let now: Date

    var body: some View {
        let status = SubscriptionsStore.stateBadge(codex.state, limitReached: codex.limitReached)
        let issue = SubscriptionsStore.codexIssue(codex)
        // The bar is drawn ONLY for a measured number — zero would falsely claim "nothing used"
        // where in fact we know nothing.
        let measured = codex.windows.filter { $0.usedPct != nil }

        Card {
            VStack(alignment: .leading, spacing: 12) {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(spacing: 6) {
                            Text("ChatGPT Codex").font(Theme.F.body.weight(.semibold))
                            if let plan = codex.planType {
                                Badge(plan, variant: .outline)
                            }
                        }
                        Text("codex-home").font(Theme.F.meta).foregroundStyle(Theme.C.mutedForeground)
                    }
                    Spacer()
                    VStack(alignment: .trailing, spacing: 4) {
                        Badge(status.text, variant: badgeVariant(status.tone))
                        Text(SubscriptionsStore.measuredLabel(codex.fetchedAt, now: now))
                            .font(Theme.F.meta)
                            .foregroundStyle(Theme.C.mutedForeground)
                    }
                }

                if let issue {
                    Text(issue).font(Theme.F.meta).foregroundStyle(Theme.C.mutedForeground)
                }

                ForEach(Array(measured.enumerated()), id: \.offset) { _, window in
                    QuotaBar(
                        label: "\(SubscriptionsStore.codexWindowLabel(window.windowMinutes)) window",
                        pct: window.usedPct.map { $0 / 100 },
                        caption: SubscriptionsStore.resetCountdown(window.resetsAt, now: now)
                    )
                }

                if let credits = codex.credits {
                    HStack {
                        Text("Credits").font(Theme.F.meta).foregroundStyle(Theme.C.mutedForeground)
                        Spacer()
                        Text(credits.unlimited ? "unlimited" : (credits.balance.map { String(format: "%.0f", $0) } ?? "—"))
                            .font(.system(size: 12, design: .monospaced))
                    }
                }
            }
        }
    }
}

// MARK: - Grok card

private struct GrokCardView: View {
    let grok: GrokSubscriptionView
    let now: Date

    var body: some View {
        let status = SubscriptionsStore.stateBadge(grok.state)
        let issue = SubscriptionsStore.grokIssue(grok)

        Card {
            VStack(alignment: .leading, spacing: 12) {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(spacing: 6) {
                            Text("Grok").font(Theme.F.body.weight(.semibold))
                            if let tier = grok.tier {
                                Badge(tier, variant: .outline)
                            }
                        }
                        Text("grok-home").font(Theme.F.meta).foregroundStyle(Theme.C.mutedForeground)
                    }
                    Spacer()
                    VStack(alignment: .trailing, spacing: 4) {
                        Badge(status.text, variant: badgeVariant(status.tone))
                        Text(SubscriptionsStore.measuredLabel(grok.fetchedAt, now: now))
                            .font(Theme.F.meta)
                            .foregroundStyle(Theme.C.mutedForeground)
                    }
                }

                if let issue {
                    Text(issue).font(Theme.F.meta).foregroundStyle(Theme.C.mutedForeground)
                }

                if let pct = grok.usedPct {
                    QuotaBar(
                        label: "Usage window",
                        pct: pct / 100,
                        caption: SubscriptionsStore.resetCountdown(grok.resetsAt, now: now)
                    )
                } else if grok.state == .ok {
                    // xAI does not expose a percentage for SuperGrok — a dash with the countdown to reset, not
                    // a falsely empty bar (see web).
                    QuotaBar(
                        label: "Usage window",
                        pct: nil,
                        caption: SubscriptionsStore.resetCountdown(grok.resetsAt, now: now)
                    )
                    Text("xAI doesn't report a usage percentage for this tier — only when the window resets. The number lights up automatically if the API starts sending one.")
                        .font(Theme.F.meta)
                        .foregroundStyle(Theme.C.mutedForeground)
                }

                Link("grok.com →", destination: URL(string: "https://grok.com")!)
                    .font(Theme.F.meta.weight(.medium))
                    .foregroundStyle(Theme.C.foreground)
            }
        }
    }
}

// MARK: - OpenRouter card (read-only — the app does not edit the key/model, see the task brief)

private struct OpenrouterCardView: View {
    let view: OpenrouterView?

    var body: some View {
        let status = SubscriptionsStore.openrouterStatus(view)
        Card {
            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("OpenRouter").font(Theme.F.body.weight(.semibold))
                        Text("Claude Code + OpenRouter profile").font(Theme.F.meta).foregroundStyle(Theme.C.mutedForeground)
                    }
                    Spacer()
                    Badge(status.text, variant: status.tone == .ok ? .default : .secondary)
                }
                HStack {
                    Text("API key").font(Theme.F.meta).foregroundStyle(Theme.C.mutedForeground)
                    Spacer()
                    Text(view?.hasKey == true ? "configured" : "not set").font(.system(size: 12, design: .monospaced))
                }
                HStack {
                    Text("Model").font(Theme.F.meta).foregroundStyle(Theme.C.mutedForeground)
                    Spacer()
                    Text(view?.model ?? "—").font(.system(size: 12, design: .monospaced))
                }
                Text("Sessions on this profile send your code to the model's provider. Stealth models retain prompts and completions — check the model's page before pointing private repos at it.")
                    .font(Theme.F.meta)
                    .foregroundStyle(Theme.C.mutedForeground)
            }
        }
    }
}

// MARK: - Shared

/// Status badge variant as on the web (`Subscriptions.tsx`): ok → default, danger →
/// destructive, otherwise secondary.
private func badgeVariant(_ severity: SubscriptionsStore.Severity) -> BadgeVariant {
    switch severity {
    case .ok: return .default
    case .warn: return .secondary
    case .danger: return .destructive
    }
}
