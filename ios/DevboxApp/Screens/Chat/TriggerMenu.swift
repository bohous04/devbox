import SwiftUI

/// The `/` and `@` menu (dashboard/src/components/chat/TriggerMenu.tsx). On the Mac a list above the composer, picked
/// with the arrow keys and Return or Tab in the field (ComposerView) or a click; on the iPhone a bar of suggestions
/// right above the composer, so above the keyboard, picked with a tap. The field keeps focus either way.
struct TriggerMenu: View {
    let model: TriggerMenuModel
    let active: Int
    /// The pointer is over a row (Mac): it becomes the highlighted one, as on the web.
    let onHighlight: (Int) -> Void
    let onPick: (String) -> Void

    var body: some View {
        #if os(macOS)
        list
        #else
        bar
        #endif
    }

    private var statusLine: some View {
        Text(model.status ?? "")
            .font(Theme.F.meta)
            .foregroundStyle(model.statusIsError ? Theme.C.dangerText : Theme.C.mutedForeground)
    }

    private var list: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(model.title).font(.system(size: 11, weight: .medium)).foregroundStyle(Theme.C.mutedForeground)
                .padding(.horizontal, 12).padding(.top, 8).padding(.bottom, 4)
            if !model.options.isEmpty {
                ScrollViewReader { proxy in
                    ScrollView {
                        VStack(alignment: .leading, spacing: 0) {
                            ForEach(Array(model.options.enumerated()), id: \.offset) { i, o in
                                row(o, highlighted: i == active).id(i).onHover { if $0 { onHighlight(i) } }
                            }
                        }
                        .padding(.horizontal, 4)
                    }
                    .frame(maxHeight: 256)
                    .fixedSize(horizontal: false, vertical: true)
                    .opacity(model.searching ? 0.6 : 1)
                    .onChange(of: active) { _, i in proxy.scrollTo(i) }
                }
            }
            if model.status != nil { statusLine.padding(.horizontal, 12).padding(.top, 2) }
        }
        .padding(.bottom, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        // The shadow on the card's shape alone: on the whole view it would shade the highlighted row too.
        .background(RoundedRectangle(cornerRadius: 12).fill(Theme.C.card).shadow(color: .black.opacity(0.12), radius: 12, y: 4))
        // The thread fades out just above the menu, as it does above the composer: a card's edge right behind the
        // menu's top (the changes card, the same width) read as a doubled border.
        .background(alignment: .top) {
            // Solid over the last 10 pt above the menu, fading out over the 10 pt above that, and on behind the menu's
            // top corners (12 pt), so the card behind does not show in their rounding.
            LinearGradient(stops: [.init(color: Theme.C.background.opacity(0), location: 0), .init(color: Theme.C.background, location: 10 / 32)],
                           startPoint: .top, endPoint: .bottom)
                .frame(height: 32).offset(y: -20).allowsHitTesting(false)
        }
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Theme.C.border))
    }

    private func row(_ o: TriggerOption, highlighted: Bool) -> some View {
        Button { if !model.searching { onPick(o.value) } } label: {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text(o.label).font(.system(size: ChatType.s(14), design: .monospaced)).foregroundStyle(Theme.C.foreground)
                    .lineLimit(1).truncationMode(.middle)
                    .layoutPriority(o.detail == nil ? 1 : 2)
                if let d = o.detail {
                    Text(d).font(Theme.F.meta).foregroundStyle(Theme.C.mutedForeground).lineLimit(1).help(d)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 8).padding(.vertical, 6)
            .background(highlighted ? Theme.C.muted : .clear, in: RoundedRectangle(cornerRadius: 8))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(o.detail.map { "\(o.label), \($0)" } ?? o.label)
        .accessibilityAddTraits(highlighted ? .isSelected : [])
    }

    /// The highlighted option's detail (a command's description) under the chips, which have room for the name only.
    private var activeDetail: String? {
        model.options.indices.contains(active) ? model.options[active].detail : nil
    }

    private var bar: some View {
        VStack(alignment: .leading, spacing: 2) {
            chips
            // Commands have details (files none): the line stays, blank for an option without one or no match, so the
            // bar does not jump as the arrows move or the filter narrows.
            if model.title == "Commands" {
                Text(activeDetail ?? " ").font(Theme.F.meta).foregroundStyle(Theme.C.mutedForeground).lineLimit(1)
                    .padding(.horizontal, 6)
                    .opacity(model.searching ? 0.6 : 1)
                    // The chip's own label says it already.
                    .accessibilityHidden(true)
            }
        }
    }

    private var chips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(Array(model.options.enumerated()), id: \.offset) { i, o in
                    Button { if !model.searching { onPick(o.value) } } label: {
                        // A path shows its file name first: the end is what tells files apart.
                        Text(o.label).font(.system(size: 14, design: .monospaced)).lineLimit(1).truncationMode(.head)
                            .frame(maxWidth: 220)
                            .foregroundStyle(Theme.C.foreground)
                            .padding(.horizontal, 12).frame(minHeight: 36)
                            .background(i == active ? Theme.C.muted : Theme.C.card, in: Capsule())
                            .overlay(Capsule().strokeBorder(Theme.C.border))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(o.detail.map { "\(o.label), \($0)" } ?? o.label)
                    // A long press shows any chip's detail, with the pick.
                    .contextMenu {
                        if let d = o.detail { Text(d) }
                        Button { onPick(o.value) } label: { Label("Insert \(o.label)", systemImage: "text.insert") }
                            .disabled(model.searching)
                    }
                }
                if model.status != nil { statusLine.padding(.horizontal, 4) }
            }
            .padding(.horizontal, 2)
        }
        .opacity(model.searching && !model.options.isEmpty ? 0.6 : 1)
        .frame(height: 40)
    }
}
