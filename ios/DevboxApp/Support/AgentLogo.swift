import SwiftUI

/// An agent's mark (dashboard/src/components/agentLogos.tsx, the same paths as template SVGs in
/// Assets.xcassets/AgentLogos; sources and licence there and in THIRD_PARTY_NOTICES.md). Drawn in the caller's
/// foreground style, as metadata: colour in these apps means status. A mark's `brand` draws it in its brand colour
/// instead; off for every mark.
struct AgentLogo: View {
    enum Mark: String, CaseIterable {
        case claude, gemini, mistral, generic

        /// Simple Icons has no OpenAI or xAI mark: Codex and Grok take the generic one. Antigravity takes Google
        /// Gemini's sparkle (no Antigravity mark either).
        init(_ agent: AgentName) {
            switch agent {
            case .claude, .claudeGemini, .claudeOpenrouter: self = .claude
            case .antigravity: self = .gemini
            case .vibe: self = .mistral
            case .codex, .grok, .unknown: self = .generic
            }
        }

        init(agent raw: String) { self.init(AgentName(rawValue: raw) ?? .unknown) }

        var asset: String { "agent-\(rawValue)" }

        /// Per mark: draw it in its brand colour (`hex`, Simple Icons') instead of the text's. Off for every mark.
        var showsBrand: Bool {
            switch self {
            case .claude, .gemini, .mistral, .generic: false
            }
        }

        var hex: UInt32? {
            switch self {
            case .claude: 0xD97757
            case .gemini: 0x8E75B2
            case .mistral: 0xFA520F
            case .generic: nil
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
