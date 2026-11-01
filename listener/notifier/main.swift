import Foundation
import UserNotifications

// devbox-notify — post a user notification carrying this bundle's icon, and
// forward notification clicks to the devbox listener (/clicked).
//
//   devbox-notify --status                              print auth status, exit 0 iff authorized
//   devbox-notify --hello                               first-run: request permission, post a hello
//   devbox-notify <title> <message...> [--sound] [--user-info <json>]
//   devbox-notify                                       no args = launched by a notification click
//                                                       (LaunchServices): wait ~5 s for the queued
//                                                       click payload, POST it to /clicked, exit
//
// Must live inside Devbox Notifier.app — UNUserNotificationCenter requires a bundle.

let center = UNUserNotificationCenter.current()

struct Cli {
    var status = false
    var hello = false
    var sound = false
    var userInfo: [String: Any]? = nil
    var positional: [String] = []
}

func parseArgs(_ args: [String]) -> Cli {
    var cli = Cli()
    var i = 0
    while i < args.count {
        switch args[i] {
        case "--status": cli.status = true
        case "--hello": cli.hello = true
        case "--sound": cli.sound = true
        case "--user-info":
            i += 1
            if i < args.count, let data = args[i].data(using: .utf8),
               let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] {
                cli.userInfo = obj
            }
        default:
            if !args[i].hasPrefix("--") { cli.positional.append(args[i]) }
        }
        i += 1
    }
    return cli
}

func fail(_ message: String, _ code: Int32) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(code)
}

func describe(_ status: UNAuthorizationStatus) -> String {
    switch status {
    case .authorized: return "authorized"
    case .denied: return "denied"
    case .notDetermined: return "notDetermined"
    case .provisional: return "provisional"
    default: return "other(\(status.rawValue))"
    }
}

let cli = parseArgs(Array(CommandLine.arguments.dropFirst()))

func post(title: String, body: String, sound: Bool, userInfo: [String: Any]?) {
    let content = UNMutableNotificationContent()
    content.title = title
    content.body = body
    if sound { content.sound = .default }
    if let ui = userInfo { content.userInfo = ui }
    let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
    center.add(request) { error in
        if let error = error { fail("add: \(error.localizedDescription)", 1) }
        exit(0)
    }
    // Posting on an already-authorized app resolves in well under a second.
    DispatchQueue.global().asyncAfter(deadline: .now() + 15) { fail("timed out posting", 4) }
}

// ── Click forwarding ────────────────────────────────────────────────────────
// Reads the listener's own config from disk and POSTs the clicked notification's
// userInfo to /clicked with the Bearer token. Best-effort: any failure = silent.

func forwardClick(_ userInfo: [AnyHashable: Any]) {
    let path = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent(".config/devbox-listener/config.json")
    guard let data = try? Data(contentsOf: path),
          let cfg = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
          let token = cfg["token"] as? String else { return }
    var host = (cfg["host"] as? String) ?? "127.0.0.1"
    if host == "0.0.0.0" { host = "127.0.0.1" }
    let port = (cfg["port"] as? Int) ?? 7777
    guard let url = URL(string: "http://\(host):\(port)/clicked") else { return }
    var stringInfo: [String: String] = [:]
    for (k, v) in userInfo {
        if let ks = k as? String, let vs = v as? String { stringInfo[ks] = vs }
    }
    guard let body = try? JSONSerialization.data(withJSONObject: stringInfo) else { return }
    var req = URLRequest(url: url, timeoutInterval: 3)
    req.httpMethod = "POST"
    req.httpBody = body
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    let sem = DispatchSemaphore(value: 0)
    URLSession.shared.dataTask(with: req) { _, _, _ in sem.signal() }.resume()
    _ = sem.wait(timeout: .now() + 4)
}

final class ClickDelegate: NSObject, UNUserNotificationCenterDelegate {
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        forwardClick(response.notification.request.content.userInfo)
        completionHandler()
        exit(0)
    }
}

let clickDelegate = ClickDelegate()

if cli.positional.isEmpty && !cli.status && !cli.hello {
    // Launched by a notification click: macOS queues the response and delivers it
    // once a delegate is set. If nothing arrives (someone ran the bare binary),
    // exit quietly — bare runs must never post notifications (the earlier "hello" bug).
    center.delegate = clickDelegate
    DispatchQueue.global().asyncAfter(deadline: .now() + 5) { exit(0) }
    dispatchMain()
}

center.getNotificationSettings { settings in
    if cli.status {
        print(describe(settings.authorizationStatus))
        exit(settings.authorizationStatus == .authorized ? 0 : 3)
    }
    let title = cli.positional.first ?? "Devbox"
    let body = cli.hello ? "Notifications work." : cli.positional.dropFirst().joined(separator: " ")
    switch settings.authorizationStatus {
    case .authorized, .provisional:
        post(title: title, body: body, sound: cli.sound, userInfo: cli.userInfo)
    case .notDetermined:
        center.requestAuthorization(options: [.alert, .sound]) { granted, error in
            if let error = error { fail("requestAuthorization: \(error.localizedDescription)", 2) }
            if granted { post(title: title, body: body, sound: cli.sound, userInfo: cli.userInfo) }
            else { fail("notifications declined", 2) }
        }
    default:
        fail("notifications are denied for Devbox — enable them in System Settings > Notifications", 2)
    }
}

// Watchdog: never hang the caller; first-run authorization can wait on the user.
DispatchQueue.global().asyncAfter(deadline: .now() + 180) {
    fail("timed out waiting for authorization/delivery", 4)
}
dispatchMain()
