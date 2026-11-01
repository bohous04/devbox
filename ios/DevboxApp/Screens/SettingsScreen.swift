import SwiftUI

/// Onboarding and management of the network configuration (CF Access + tailnet) + (after onboarding) Vault/Accounts/
/// Configuration. `DevboxAppApp` shows it as a fullscreen sheet (`prefill == false`, the default)
/// while `AppModel.configState == .notConfigured` — it closes itself as soon as Save stores at least one
/// working path (reactively, via `AppModel.configState`). `MoreScreen` navigates to it with `prefill: true`.
///
/// Its own `NavigationStack` is NOT part of this View (unlike an earlier version) — `MoreScreen`
/// pushes it inside ITS `NavigationStack` (a nested `NavigationStack` would break the back gesture and
/// produce two navigation bars on top of each other). The onboarding caller (`DevboxAppApp`) wraps the `NavigationStack`
/// itself.
struct SettingsScreen: View {
    @EnvironmentObject private var appModel: AppModel

    /// `true` = opened from More (outside onboarding) — loads the existing configuration from the Keychain
    /// (P0 trap from the stage B/C review: without prefill an empty Save would delete a working path) and
    /// shows the Vault/Accounts/Configuration sections, which make no sense during onboarding (no
    /// working client exists yet). Onboarding calls the default `SettingsScreen()` — the fields
    /// stay empty as before.
    var prefill = false

    @State private var hostname = ""
    @State private var cfId = ""
    @State private var cfSecret = ""
    @State private var tailnet = ""

    @State private var isTesting = false
    @State private var testResult: TestResult?
    @State private var saveError: String?
    /// Prefill from More hit an unreadable Keychain (`currentConfig() == nil`) — the fields
    /// stay empty and both Save and Test are blocked, otherwise the empty fields would delete the stored data.
    @State private var keychainUnavailable = false

    private enum TestResult {
        case success(version: String)
        case failure(message: String)
    }

    var body: some View {
        // Cards instead of a `Form` (web `Settings.tsx`), the fields inside stay native. A plain
        // `VStack`, not `ScreenScroll` (`LazyVStack`) — lazy building could discard the state of
        // a half-typed field that scrolls off screen.
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.S.sectionGap) {
                if keychainUnavailable {
                    Label(Self.keychainUnavailableText, systemImage: "exclamationmark.triangle")
                        .font(Theme.F.meta)
                        .foregroundStyle(Theme.C.dangerText)
                }

                SettingsCard("Cloudflare Access", footer: "Leave blank to use the tailnet address only.") {
                    TextField("Hostname", text: $hostname)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                    TextField("Client Id", text: $cfId)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    SecureField("Client Secret", text: $cfSecret)
                }

                SettingsCard("Tailnet") {
                    TextField("Tailnet URL", text: $tailnet)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                }

                VStack(alignment: .leading, spacing: 8) {
                    Button {
                        Task { await testConnection() }
                    } label: {
                        HStack {
                            Text("Test connection")
                            if isTesting {
                                ProgressView()
                            }
                        }
                        .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(DevboxButtonStyle(variant: .outline))
                    .disabled(isTesting || keychainUnavailable)

                    if let testResult {
                        testResultLabel(testResult)
                            .font(Theme.F.meta)
                    }
                }

                if prefill, let client = appModel.client {
                    AgentActivitySection(manager: appModel.liveActivityManager)
                    VaultSection(appModel: appModel)
                    AccountsSection(client: client)
                    ConfigurationSection(client: client)
                }
            }
            .textFieldStyle(.roundedBorder)
            .padding(Theme.S.screenPadding)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(Theme.C.background)
        .navigationTitle("Settings")
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Save") { save() }
                    .disabled(keychainUnavailable)
            }
        }
        .alert("Save failed", isPresented: Binding(
            get: { saveError != nil },
            set: { isPresented in if !isPresented { saveError = nil } }
        )) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(saveError ?? "")
        }
        .task {
            guard prefill else { return }
            guard let config = appModel.currentConfig() else {
                keychainUnavailable = true
                return
            }
            keychainUnavailable = false
            hostname = config.hostname
            cfId = config.cfId
            cfSecret = config.cfSecret
            tailnet = config.tailnet
        }
    }

    @ViewBuilder
    private func testResultLabel(_ result: TestResult) -> some View {
        switch result {
        case .success(let version):
            Label("Connected — devd \(version)", systemImage: "checkmark.circle")
                .foregroundStyle(Theme.C.okText)
        case .failure(let message):
            Label(message, systemImage: "xmark.circle")
                .foregroundStyle(Theme.C.dangerText)
        }
    }

    /// "Test connection" tests the form values through a temporary client and saves them ONLY after
    /// success — a failed (or empty) test must not overwrite or delete a working configuration.
    private func testConnection() async {
        isTesting = true
        defer { isTesting = false }
        switch await appModel.testConnection(hostname: hostname, cfId: cfId, cfSecret: cfSecret, tailnet: tailnet) {
        case .success(let version):
            testResult = .success(version: version)
            save()
        case .failure(let error):
            testResult = .failure(message: errorText(error))
        }
    }

    static let keychainUnavailableText = "Keychain is unavailable right now — try again in a moment."

    private func save() {
        guard !keychainUnavailable else { return }
        if case .failure(let error) = appModel.saveConfig(hostname: hostname, cfId: cfId, cfSecret: cfSecret, tailnet: tailnet) {
            saveError = error.description
        }
        // On success the sheet closes itself as soon as `AppModel.configState` changes to `.configured` —
        // see the binding in `DevboxAppApp`. Without a valid path it stays open (forced onboarding).
    }
}

// MARK: - Karta sekce

/// Settings section like on the web: `SectionHeader` above the card, an optional note below it (formerly
/// the `Form` footer). The content is native fields/buttons stacked vertically.
private struct SettingsCard<Content: View>: View {
    private let title: String
    private let footer: String?
    private let content: Content

    init(_ title: String, footer: String? = nil, @ViewBuilder content: () -> Content) {
        self.title = title
        self.footer = footer
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionHeader(title)
            Card {
                VStack(alignment: .leading, spacing: 12) {
                    content
                }
            }
            if let footer {
                Text(footer)
                    .font(Theme.F.meta)
                    .foregroundStyle(Theme.C.mutedForeground)
            }
        }
    }
}

// MARK: - Live Activity

/// Agent Live Activity (Dynamic Island + lock screen) driven from the server — enabling,
/// registration state and restoring after a manual dismissal (swipe away is respected until "Show again").
private struct AgentActivitySection: View {
    @ObservedObject var manager: AgentLiveActivityManager

    var body: some View {
        SettingsCard("Live Activity", footer: "Status of all agents in the Dynamic Island and on the Lock Screen. Tap to open a session.") {
            Toggle("Show agent status on iPhone", isOn: Binding(
                get: { manager.enabled }, set: { manager.setEnabled($0) }
            ))
            .font(Theme.F.body)
            Text(manager.statusText)
                .font(Theme.F.meta)
                .foregroundStyle(Theme.C.mutedForeground)
                .accessibilityIdentifier("agentActivityStatus")
            if manager.enabled && manager.dismissed {
                Button("Show activity again") { manager.resume() }
                    .buttonStyle(DevboxButtonStyle(variant: .outline))
            }
            if manager.enabled {
                Button("Reconnect") { manager.retry() }
                    .buttonStyle(DevboxButtonStyle(variant: .outline))
            }
        }
    }
}

// MARK: - Vault

/// Vault state + unlocking — mirrors `dashboard/src/components/VaultGate.tsx`, but as a section
/// inside Settings, not a blocking gate (the app does not want to lock the whole UI, only show a banner — see
/// `SessionsContainer` in DevboxAppApp.swift). The form and its state are shared with the banner
/// (`VaultUnlockRows`/`VaultUnlockController` in VaultUnlockView.swift); here additionally
/// "Forget saved passphrase" for an unlocked vault.
private struct VaultSection: View {
    @EnvironmentObject private var appModel: AppModel
    @StateObject private var controller: VaultUnlockController

    init(appModel: AppModel) {
        _controller = StateObject(wrappedValue: VaultUnlockController(appModel: appModel))
    }

    var body: some View {
        SettingsCard("Vault", footer: "Sessions keep running while the vault is locked, but anything that needs credentials fails until you unlock it.") {
            if appModel.vaultLocked {
                VaultUnlockRows(controller: controller)
            } else {
                Label("Unlocked", systemImage: "lock.open")
                    .font(Theme.F.body)
                    .foregroundStyle(Theme.C.okText)
                if controller.hasSaved {
                    Button("Forget saved passphrase", role: .destructive) { controller.forget() }
                        .buttonStyle(DevboxButtonStyle(variant: .outline))
                }
            }
        }
        .task {
            controller.refresh()
            await appModel.refreshVaultStatus()
        }
    }
}

// MARK: - Accounts (auth stavy, READ-ONLY)

/// Display of provider states only — mirrors `dashboard/src/pages/Settings.tsx` `Accounts()`, but
/// without login flows (device codes / OAuth redirects). Deliberate narrowing (see the task brief): interactive
/// login belongs on the web, the app only shows whether each provider is logged in.
private struct AccountsSection: View {
    let client: DevdClient

    @State private var status: AuthStatus?
    @State private var error: String?

    var body: some View {
        SettingsCard("Accounts", footer: "Sign-in flows (device codes, OAuth) are web-only — open the dashboard to log in or out.") {
            if let status {
                row("Claude", status.claude)
                row("Codex CLI", status.codex)
                row("Proxy · ChatGPT", status.proxyCodex)
                row("Proxy · xAI", status.proxyXai)
                if let proxyAntigravity = status.proxyAntigravity { row("Proxy · Antigravity", proxyAntigravity) }
                row("Grok Build", status.grok)
                if let antigravity = status.antigravity { row("Antigravity", antigravity) }
            } else if let error {
                Text(error).font(Theme.F.meta).foregroundStyle(Theme.C.dangerText)
            } else {
                ProgressView()
            }
        }
        .task { await load() }
    }

    @ViewBuilder
    private func row(_ label: String, _ provider: AuthProvider) -> some View {
        HStack {
            Text(label).font(Theme.F.body)
            Spacer()
            HStack(spacing: 6) {
                StatusDot(provider.loggedIn ? .ok : .idle)
                Text(provider.loggedIn ? "Logged in" : "Logged out")
                    .font(Theme.F.meta)
                    .foregroundStyle(provider.loggedIn ? Theme.C.okText : Theme.C.mutedForeground)
            }
        }
    }

    private func load() async {
        do {
            status = try await client.get("/api/auth")
        } catch {
            self.error = errorText(error)
        }
    }
}

// MARK: - Configuration (read-only JSON preview)

/// Simplified to a read-only preview — mirrors only the READ from `dashboard/src/pages/Settings.tsx`
/// (`GET /api/config`), not the full visual/JSON editor with validation and Save+push. Deliberate narrowing (see
/// the task brief): editing the config from a phone is risky (no undo, easy JSON typo) and the full
/// editor belongs on the web — the app fulfils spec parity by displaying, not editing.
private struct ConfigurationSection: View {
    let client: DevdClient

    @State private var jsonText: String?
    @State private var error: String?

    var body: some View {
        SettingsCard("Configuration", footer: "Read-only preview — edit the full configuration on the web dashboard.") {
            if let jsonText {
                ScrollView(.horizontal) {
                    Text(jsonText)
                        .font(.system(size: 11, design: .monospaced))
                        .textSelection(.enabled)
                }
                .frame(maxHeight: 260)
            } else if let error {
                Text(error).font(Theme.F.meta).foregroundStyle(Theme.C.dangerText)
            } else {
                ProgressView()
            }
        }
        .task { await load() }
    }

    private func load() async {
        do {
            let value: JSONPreviewValue = try await client.get("/api/config")
            let data = try JSONSerialization.data(
                withJSONObject: value.foundationValue,
                options: [.prettyPrinted, .sortedKeys]
            )
            jsonText = String(data: data, encoding: .utf8)
        } catch {
            self.error = errorText(error)
        }
    }
}

/// Generic JSON value only for `ConfigurationSection` — `/api/config` has a free shape (folders,
/// settings, giteaInstances, accountPool, …) and the app does not edit it, only pretty-prints it. A custom
/// `Decodable` instead of the narrowed `DevdConfig` (which in Models.swift knows only `version` so far), so the
/// preview shows the WHOLE config, not just one field. No secrets — `/api/config` contains neither gitea tokens nor
/// CF secrets (those live elsewhere, see `GiteaInstanceInfo.hasToken`), so it is safe to print
/// in full.
private enum JSONPreviewValue: Decodable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: JSONPreviewValue])
    case array([JSONPreviewValue])
    case null

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        // Order is intentional: `Bool` first (JSONDecoder would not coerce `true`/`false` into `Double` anyway,
        // but it follows the same idiom as elsewhere in the app).
        if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([String: JSONPreviewValue].self) {
            self = .object(value)
        } else if let value = try? container.decode([JSONPreviewValue].self) {
            self = .array(value)
        } else {
            self = .null
        }
    }

    /// Conversion to a `JSONSerialization`-compatible tree (`NSDictionary`/`NSArray`/…) so it can
    /// be pretty-printed via `.prettyPrinted`.
    var foundationValue: Any {
        switch self {
        case .string(let value): return value
        case .number(let value): return value
        case .bool(let value): return value
        case .object(let value): return value.mapValues { $0.foundationValue }
        case .array(let value): return value.map { $0.foundationValue }
        case .null: return NSNull()
        }
    }
}

#Preview {
    // The preview must not call the production `AppModel()` (default `KeychainStore` with biometrics) —
    // the simulator/preview environment has no enrolled biometrics, same reason as the tests.
    NavigationStack {
        SettingsScreen()
    }
    .environmentObject(AppModel(keychain: KeychainStore(requireBiometryForVault: false)))
}
