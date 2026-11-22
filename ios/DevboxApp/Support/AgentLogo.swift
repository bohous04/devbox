import SwiftUI

/// An agent's mark: the template SVGs in Assets.xcassets/AgentLogos, the same paths as
/// dashboard/src/components/agentLogos.tsx (agentLogos.test.ts checks they match).
///
/// Source: LobeHub Icons, npm `@lobehub/icons-static-svg@1.102.0` (https://github.com/lobehub/lobe-icons), MIT,
/// Copyright (c) 2023 LobeHub; licence text in THIRD_PARTY_NOTICES.md. The mono variants `claude`, `openai`, `grok`,
/// `antigravity` and `mistral`, paths as they are. The marks are their owners' trademarks. `agent-generic` (a ring,
/// for an agent this client does not know) is devbox's own.
///
/// Drawn in the caller's foreground style, as metadata: colour in these apps means status. A mark's `showsBrand`
/// draws it in its brand colour instead; off for every mark.
struct AgentLogo: View {
    enum Mark: String, CaseIterable {
        case claude, openai, grok, antigravity, mistral, generic

        init(_ agent: AgentName) {
            switch agent {
            case .claude, .claudeGemini, .claudeOpenrouter: self = .claude
            case .codex: self = .openai
            case .grok: self = .grok
            case .antigravity: self = .antigravity
            case .vibe: self = .mistral
            case .unknown: self = .generic
            }
        }

        init(agent raw: String) { self.init(AgentName(rawValue: raw) ?? .unknown) }

        var asset: String { "agent-\(rawValue)" }

        /// Per mark: draw it in its brand colour (`hex`) instead of the text's. Off for every mark.
        var showsBrand: Bool {
            switch self {
            case .claude, .openai, .grok, .antigravity, .mistral, .generic: false
            }
        }

        /// The set's colour variant's one colour. OpenAI's and Grok's marks are black and white; Antigravity's and
        /// Mistral's colour variants are multicolour, so a one-colour switch has none for them.
        var hex: UInt32? {
            switch self {
            case .claude: 0xD97757
            case .openai, .grok, .antigravity, .mistral, .generic: nil
            }
        }

        var brand: Color? {
            guard showsBrand, let hex else { return nil }
            return Color(red: Double(hex >> 16 & 0xFF) / 255, green: Double(hex >> 8 & 0xFF) / 255, blue: Double(hex & 0xFF) / 255)
        }
    }

    let mark: Mark
    var size: CGFloat = 12

    var body: some View {
        let image = Image(mark.asset).renderingMode(.template).resizable().scaledToFit().frame(width: size, height: size)
        // The agent's name is said by the row or chip it sits in, as the web's aria-hidden mark.
        Group { if let brand = mark.brand { image.foregroundStyle(brand) } else { image } }.accessibilityHidden(true)
    }
}
