import SwiftUI

/// Settings: the connection (the iOS app's Settings screen: Cloudflare Access and tailnet, kept in the Keychain,
/// plus vault and accounts) and launch at login.
struct MacSettings: View {
    @EnvironmentObject private var state: MacAppState

    var body: some View {
        TabView {
            NavigationStack { SettingsScreen(prefill: true) }
                .tabItem { Label("Connection", systemImage: "network") }
            LoginItemSettings(item: state.loginItem)
                .tabItem { Label("General", systemImage: "gearshape") }
        }
        .frame(width: 560, height: 620)
    }
}

private struct LoginItemSettings: View {
    @ObservedObject var item: LoginItem

    var body: some View {
        Form {
            Toggle("Open Devbox at login", isOn: Binding(get: { item.enabled }, set: { item.set(enabled: $0) }))
            Text("Devbox reopens the windows and threads you had open.")
                .font(Theme.F.meta).foregroundStyle(Theme.C.mutedForeground)
            if let status = item.statusText {
                Text(status).font(Theme.F.meta).foregroundStyle(Theme.C.warnText)
            }
            if let error = item.error {
                Text(error).font(Theme.F.meta).foregroundStyle(Theme.C.dangerText)
            }
        }
        .padding()
        .onAppear { item.refresh() }
    }
}
