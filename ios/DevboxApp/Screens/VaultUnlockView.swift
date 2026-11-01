import SwiftUI

/// Vault unlock state shared by three places: the banner above the tabs (`SessionsContainer`),
/// the sheet from that banner (`VaultUnlockSheet`) and the Vault section in Settings. Formerly everything lived
/// only in Settings and the banner merely pointed there — unlocking via Face ID was thus three taps
/// deep and without "Remember" one would not even learn about it. The logic is in `AppModel`
/// (network, Keychain); this holds only the form state.
@MainActor
final class VaultUnlockController: ObservableObject {
    @Published var passphrase = ""
    /// Save the passphrase for the next one-tap unlock. Default ON when the device has
    /// biometrics — without them nothing is promised (the stored value could be read without Face ID, because
    /// the `.biometryCurrentSet` access control does not even allow the write on such a device).
    @Published var remember: Bool
    @Published private(set) var hasSaved: Bool
    @Published private(set) var busy = false
    @Published var error: String?
    /// "Face ID" / "Touch ID" for labels; `nil` = device without biometrics.
    let biometry: String?

    private let appModel: AppModel

    init(appModel: AppModel, biometry: String? = LocalAuthGate.biometryName()) {
        self.appModel = appModel
        self.biometry = biometry
        remember = biometry != nil
        hasSaved = appModel.vaultPassphraseSaved()
    }

    var savedButtonTitle: String { "Unlock with \(biometry ?? "saved passphrase")" }
    var rememberTitle: String { biometry.map { "Remember for \($0)" } ?? "Remember passphrase" }

    /// Whether a saved passphrase exists, without reading it (no Face ID prompt) — called on appearance.
    func refresh() {
        hasSaved = appModel.vaultPassphraseSaved()
    }

    func unlockWithSaved() async {
        busy = true
        error = nil
        defer { busy = false }
        if case .failure(let err) = await appModel.unlockVaultWithSavedPassphrase() {
            // Dismissed Face ID dialog = the user changed their mind, no message.
            if (err as? BiometricError) != .cancelled {
                error = AppModel.unlockErrorText(err)
            }
            // After a 401 `AppModel` forgot the saved value → switch to manual entry.
            hasSaved = appModel.vaultPassphraseSaved()
        }
    }

    func unlockTyped() async {
        busy = true
        error = nil
        defer { busy = false }
        let value = passphrase
        switch await appModel.unlockVault(passphrase: value) {
        case .success:
            // `hasSaved` may turn on only after a genuinely successful write — otherwise next time
            // a one-tap unlock would be offered for a key that is not in the Keychain at all.
            if remember {
                hasSaved = appModel.rememberVaultPassphrase(value)
            }
            passphrase = ""
        case .failure(let err):
            error = AppModel.unlockErrorText(err)
        }
    }

    func useDifferentPassphrase() {
        hasSaved = false
        error = nil
    }

    func forget() {
        appModel.forgetVaultPassphrase()
        hasSaved = false
    }
}

/// Rows of the unlock form — inserted into a `Section` (Settings) and into a `Form` in the sheet,
/// hence no container of its own. Without a `Section`/`Form` around them the `SecureField` and `Toggle`
/// would render as bare elements.
struct VaultUnlockRows: View {
    @ObservedObject var controller: VaultUnlockController

    var body: some View {
        if controller.hasSaved {
            Button {
                Task { await controller.unlockWithSaved() }
            } label: {
                HStack {
                    Label(controller.savedButtonTitle, systemImage: controller.biometry == "Touch ID" ? "touchid" : "faceid")
                    if controller.busy {
                        Spacer()
                        ProgressView()
                    }
                }
            }
            .disabled(controller.busy)
            Button("Use a different passphrase") { controller.useDifferentPassphrase() }
                .font(.footnote)
        } else {
            SecureField("Passphrase", text: $controller.passphrase)
                .textContentType(.password)
                .submitLabel(.go)
                .onSubmit { if !controller.passphrase.isEmpty { Task { await controller.unlockTyped() } } }
            Toggle(controller.rememberTitle, isOn: $controller.remember)
            Button {
                Task { await controller.unlockTyped() }
            } label: {
                HStack {
                    Text("Unlock")
                    if controller.busy {
                        Spacer()
                        ProgressView()
                    }
                }
            }
            .disabled(controller.busy || controller.passphrase.isEmpty)
        }
        if let error = controller.error {
            Label(error, systemImage: "xmark.circle")
                .font(.caption)
                .foregroundStyle(.red)
        }
    }
}

/// Sheet from the "Vault locked" banner — for when there is no saved passphrase yet (first
/// unlock from the phone) or devd rejected it. Closes itself as soon as the vault stops being
/// locked (`AppModel.vaultLocked`), or via Cancel.
struct VaultUnlockSheet: View {
    @ObservedObject var controller: VaultUnlockController
    @EnvironmentObject private var appModel: AppModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    VaultUnlockRows(controller: controller)
                } header: {
                    Text("Vault")
                } footer: {
                    Text(controller.biometry.map { "With Remember on, the next unlock is a single tap confirmed by \($0)." }
                        ?? "Sessions keep running while the vault is locked, but anything that needs credentials fails until you unlock it.")
                }
            }
            .navigationTitle("Unlock vault")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
            .task { controller.refresh() }
            .onChange(of: appModel.vaultLocked) { _, locked in
                if !locked { dismiss() }
            }
        }
    }
}
