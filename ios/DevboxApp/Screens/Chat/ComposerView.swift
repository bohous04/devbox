import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// Message input (dashboard/src/components/chat/Composer.tsx). A message sent while a run is active is queued by the
/// bridge and shows as queued. On a failed send the text and images stay and nothing is retried. Images picked
/// from Photos or Files, pasted (the paperclip's menu; ⌘V on the Mac) or dropped on the box (at most 10) are scaled
/// down and re-encoded (`ImagePrep`), previewed, and go with the next message; anything that is not an image is said.
/// One box (the web's composer): attach, the field, the model chip and send on one row; from the field's second line
/// the box grows into two tiers, the field on top and the controls under it, and stays so until the text is cleared
/// (switching back while typing would make the field jump between widths). The Mac always has the two tiers.
struct ComposerView: View {
    let running: Bool
    /// The model chip (ChatSwitchers), compact on the one-row box; nil while the session's target is unknown.
    let chip: ((_ compact: Bool) -> AnyView)?
    /// false: refused with a reason shown above the composer (a tmux session's lock); the text stays, no error.
    let onSend: (String, [Data]) async throws -> Bool
    let onStop: () async throws -> Void
    /// The agent's slash commands: `/` at the start of a message opens them. nil (or none): the agent runs none (Codex)
    /// or has not said which (an older bridge), and `/` opens nothing.
    var commands: [AgentCommand]? = nil
    /// The session repo's files for `@`; nil: `@` opens nothing.
    var searchFiles: ((String) async throws -> SessionFiles)? = nil
    /// Replaces the default placeholder (a tmux session's).
    var placeholder: String? = nil
    /// Why nothing can be sent now: the empty field is off and says it (text already typed stays editable).
    var fieldOff: String? = nil
    /// Why images cannot go with a message: the attach button is off and says it, and a paste or drop says it.
    var imagesOff: String? = nil

    private struct Attached: Identifiable {
        let id = UUID()
        let data: Data
        let preview: PlatformImage?
    }

    #if DEBUG
    /// Tests see what was attached (the previews are drawn, not views a test can find): the number now attached.
    static var debugAttached: ((Int) -> Void)?
    #endif

    @State private var text = ""
    #if os(macOS)
    @State private var links = ComposerLinks()
    #endif
    @State private var images: [Attached] = []
    @State private var picks: [PhotosPickerItem] = []
    @State private var choosingFiles = false
    @State private var dropping = false
    @State private var busy = false
    @State private var stopping = false
    @State private var preparing = 0
    @State private var error: String?
    @State private var twoTier = ChatLayout.composerTwoRows
    /// The field's height with one line, measured while it is empty.
    @State private var oneLine: CGFloat = 0
    // The `/` and `@` menu: what is at the caret while the field has focus, unless Escape closed it for that word.
    @FocusState private var focused: Bool
    /// The caret (UTF-16 offset; a selection's start, as the web's selectionStart); nil while not known (no menu).
    /// CaretField says how it is found.
    @State private var caret: Int?
    @State private var setCaret: Int?
    @State private var dismissed: String?
    @State private var activeOption = 0
    @State private var fileResult: FileSearchResult?

    private var hasCommands: Bool { commands?.isEmpty == false }
    /// The trigger at the caret that this session offers, Escape or not.
    private var offeredTrigger: ComposerTrigger? {
        guard focused, let caret, let t = ComposerTriggers.active(text, caret: caret) else { return nil }
        return (t.kind == .slash ? hasCommands : searchFiles != nil) ? t : nil
    }
    private static func key(_ t: ComposerTrigger) -> String { "\(t.kind.rawValue)\(t.start)" }
    private var trigger: ComposerTrigger? { offeredTrigger.flatMap { Self.key($0) == dismissed ? nil : $0 } }
    private var menu: TriggerMenuModel? { trigger.map { TriggerMenuModel.make($0, commands: commands ?? [], files: fileResult) } }
    /// Clamped here, not only reset on change: a shorter list arrives before the reset.
    private func clamped(_ m: TriggerMenuModel) -> Int { m.options.isEmpty ? 0 : min(activeOption, m.options.count - 1) }

    private var canSend: Bool { !busy && preparing == 0 && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    private var fieldDisabled: Bool { fieldOff != nil && text.isEmpty }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if !images.isEmpty || preparing > 0 {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(images) { a in
                            ZStack(alignment: .topTrailing) {
                                Group {
                                    if let p = a.preview { Image(platformImage: p).resizable().scaledToFill() } else { Color.gray }
                                }
                                .frame(width: 56, height: 56).clipShape(RoundedRectangle(cornerRadius: Theme.R.md))
                                Button { images.removeAll { $0.id == a.id } } label: {
                                    Image(systemName: "xmark.circle.fill").symbolRenderingMode(.palette).foregroundStyle(.white, .black.opacity(0.6))
                                }
                                .accessibilityLabel("Remove image")
                                .offset(x: 4, y: -4)
                            }
                        }
                        if preparing > 0 { ProgressView().frame(width: 56, height: 56) }
                    }
                    .padding(.top, 4)
                }
            }
            #if os(iOS)
            if let m = menu {
                TriggerMenu(model: m, active: clamped(m), onHighlight: { activeOption = $0 }, onPick: pick)
            }
            #endif
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .center, spacing: 6) {
                    if !twoTier { attach }
                    field
                    if !twoTier { controls }
                }
                if twoTier {
                    HStack(spacing: 6) {
                        attach
                        Spacer(minLength: 0)
                        controls
                    }
                }
            }
            .padding(.leading, twoTier ? 14 : 6).padding(.trailing, 6).padding(.vertical, 6)
            .background(Theme.C.card, in: RoundedRectangle(cornerRadius: 22))
            .overlay(RoundedRectangle(cornerRadius: 22).strokeBorder(dropping ? Theme.C.primary : Theme.C.border))
            .onDrop(of: [.image, .fileURL], isTargeted: $dropping) { items in
                attach(items)
                return true
            }
            #if os(macOS)
            // Above the box, over the thread: it takes no room in the composer's own layout.
            .overlay(alignment: .top) {
                // A zero-height strip on the box's top edge, the menu hanging up from it at its own height.
                Color.clear.frame(height: 0).overlay(alignment: .bottom) {
                    if let m = menu {
                        TriggerMenu(model: m, active: clamped(m), onHighlight: { activeOption = $0 }, onPick: pick)
                            .fixedSize(horizontal: false, vertical: true)
                            .padding(.bottom, 8)
                    }
                }
            }
            #endif
            if let error { Text(error).font(Theme.F.meta).foregroundStyle(Theme.C.dangerText) }
        }
        // The files for the `@` word at the caret, asked once the keys pause; a newer query cancels the older one.
        .task(id: trigger?.kind == .at ? trigger?.query : nil) {
            guard let t = trigger, t.kind == .at, let searchFiles else { return }
            try? await Task.sleep(for: .milliseconds(120))
            guard !Task.isCancelled else { return }
            do {
                let files = try await searchFiles(t.query)
                if !Task.isCancelled { fileResult = FileSearchResult(query: t.query, files: files) }
            } catch is CancellationError {
            } catch {
                if !Task.isCancelled { fileResult = FileSearchResult(query: t.query, error: chatErrorText(error)) }
            }
        }
        .onChange(of: [trigger.map(Self.key), trigger?.query, menu.map { String($0.options.count) }]) { activeOption = 0 }
        // Escape closed the menu only for the word it was pressed on: no trigger word at the caret (or no focus) ends it.
        .onChange(of: offeredTrigger.map(Self.key)) { _, k in if k == nil { dismissed = nil } }
        // VoiceOver hears the menu open and change (the web's live region), and the option the arrows move to.
        .onChange(of: menu.map(ComposerTriggers.announcement)) { _, s in if let s { AccessibilityNotification.Announcement(s).post() } }
        .onChange(of: picks) { _, items in
            guard !items.isEmpty else { return }
            picks = []
            Task { await attach(items.count) { i in try await items[i].loadTransferable(type: Data.self) } }
        }
        .fileImporter(isPresented: $choosingFiles, allowedContentTypes: [.image], allowsMultipleSelection: true) { result in
            switch result {
            case .success(let urls): Task { await attach(urls.count) { i in try ImagePrep.readFile(urls[i]) } }
            case .failure(let e): error = "Image: \(chatErrorText(e))"
            }
        }
        #if os(macOS)
        .background(ImagePasteKey(active: focused) { attach($0) })
        #endif
    }

    private var attach: some View {
        Menu {
            PhotosPicker(selection: $picks, maxSelectionCount: max(1, ImagePrep.maxImagesPerMessage - images.count), matching: .images) {
                Label("Photo library", systemImage: "photo.on.rectangle")
            }
            Button { choosingFiles = true } label: { Label("Choose files…", systemImage: "folder") }
            // Not disabled by what the clipboard held when the menu was drawn (that went stale); it says when it has none.
            Button {
                let items = ImagePasteboard.providers()
                if items.isEmpty { error = "The clipboard has no image" } else { attach(items) }
            } label: { Label("Paste image", systemImage: "doc.on.clipboard") }
        } label: {
            Image(systemName: "paperclip").font(.system(size: ChatType.s(17))).foregroundStyle(Theme.C.mutedForeground)
                .frame(width: 36, height: 36).contentShape(Rectangle())
        }
        .labelOnlyMenu()
        .disabled(images.count >= ImagePrep.maxImagesPerMessage || imagesOff != nil)
        .help(imagesOff ?? "Attach images, or paste or drop them here")
        .accessibilityLabel("Attach images")
        .accessibilityHint(imagesOff ?? "")
    }

    private var field: some View {
        // The placeholder in the muted grey: in the foreground's colour an empty field looks filled in.
        CaretField(text: $text, caret: $caret, setCaret: $setCaret,
                   prompt: Text(fieldOff ?? placeholder ?? ComposerTriggers.placeholder(running: running, commands: hasCommands, files: searchFiles != nil))
                       .foregroundStyle(Theme.C.mutedForeground))
            .focused($focused)
            .disabled(fieldDisabled)
            .onKeyPress(phases: .down) { press in onKey(press) }
            .lineLimit(1...6)
            .font(.system(size: ChatType.s(16)))
            .textFieldStyle(.plain)
            .padding(.vertical, 6)
            // The model chip on the same row goes first (ChatSwitchers); the field keeps room to read and tap.
            .frame(minWidth: 96)
            .accessibilityLabel("Message")
            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { h in
                if text.isEmpty { oneLine = h }
                // Grows to two tiers at the second line; back to one row only when the text is cleared.
                if !twoTier, oneLine > 0, h > oneLine + 4 { withAnimation(.snappy) { twoTier = true } }
            }
            .onChange(of: text) { _, t in if t.isEmpty, twoTier, !ChatLayout.composerTwoRows { withAnimation(.snappy) { twoTier = false } } }
            #if os(macOS)
            .onAppear { links.text = text; links.install() }
            .onDisappear { links.remove() }
            .onChange(of: text) { _, t in
                links.text = t
                // After the field has taken the new text.
                DispatchQueue.main.async { links.decorateFocused() }
            }
            .onChange(of: focused) { _, _ in DispatchQueue.main.async { links.decorateFocused() } }
            #endif
    }

    /// The keys of the open menu (ComposerTriggers.keyAction, the web's). Return keeps its own behaviour here when no
    /// option is to be picked: the field's, as before the menu (the send button sends).
    private func onKey(_ press: KeyPress) -> KeyPress.Result {
        let name: String
        switch press.key {
        case .return: name = "Enter"
        case .tab: name = "Tab"
        case .escape: name = "Escape"
        case .upArrow: name = "ArrowUp"
        case .downArrow: name = "ArrowDown"
        default: return .ignored
        }
        let m = menu
        let state = m.map { m in
            TriggerMenuState(options: m.options.count, searching: m.searching,
                             exact: trigger.map { m.options.indices.contains(clamped(m)) && m.options[clamped(m)].value == $0.query } ?? false)
        }
        let key = TriggerKey(key: name, shift: press.modifiers.contains(.shift), alt: press.modifiers.contains(.option),
                             ctrl: press.modifiers.contains(.control), meta: press.modifiers.contains(.command), composing: Self.composing)
        switch ComposerTriggers.keyAction(state, key, enterSends: false) {
        case .fieldDefault, .send: return .ignored
        case .hold: return .handled
        case .dismiss: dismissed = trigger.map(Self.key); return .handled
        case .next, .prev:
            guard let m, !m.options.isEmpty else { return .ignored }
            let n = m.options.count
            activeOption = (clamped(m) + (press.key == .downArrow ? 1 : n - 1)) % n
            let o = m.options[activeOption]
            AccessibilityNotification.Announcement(o.detail.map { "\(o.label), \($0)" } ?? o.label).post()
            return .handled
        case .pick:
            guard let m, m.options.indices.contains(clamped(m)) else { return .ignored }
            pick(m.options[clamped(m)].value)
            return .handled
        }
    }

    /// An input method is composing in the focused field (marked text): its keys are its own.
    static var composing: Bool {
        #if os(macOS)
        (NSApp.keyWindow?.firstResponder as? NSTextView)?.hasMarkedText() ?? false
        #else
        (UIResponder.devboxFirstResponder() as? UITextInput)?.markedTextRange != nil
        #endif
    }

    private func pick(_ value: String) {
        guard let t = trigger else { return }
        let next = ComposerTriggers.pick(text, t, value)
        text = next.text
        setCaret = next.caret
    }

    @ViewBuilder
    private var controls: some View {
        if let chip { chip(!twoTier) }
        if running {
            Button { stop() } label: {
                Image(systemName: "stop.fill").font(.system(size: ChatType.s(13))).foregroundStyle(Theme.C.foreground)
                    .frame(width: 34, height: 34).background(Theme.C.muted, in: Circle())
                    .iPhoneTapTarget()
            }
            .labelOnlyButton()
            .disabled(stopping)
            .accessibilityLabel("Stop the run")
        }
        Button { send() } label: {
            Image(systemName: "arrow.up").font(.system(size: ChatType.s(15), weight: .semibold))
                // Empty: a filled circle a step off the card and a muted arrow (the web's), so the button stays in view.
                .foregroundStyle(canSend ? Theme.C.primaryForeground : Theme.C.mutedForeground)
                .frame(width: 34, height: 34)
                .background(canSend ? Theme.C.primary : Theme.C.foreground.opacity(0.1), in: Circle())
                .iPhoneTapTarget()
        }
        // Its own colours for the empty state: the system's disabled dimming would fade it into the card.
        .buttonStyle(SendButtonStyle())
        .disabled(!canSend)
        .accessibilityLabel("Send")
    }

    /// Pasted or dropped items; while images are off, their reason is said instead.
    private func attach(_ items: [NSItemProvider]) {
        if let imagesOff { error = imagesOff; return }
        Task { await attach(items.count) { i in try await ImagePrep.loadImage(items[i]) } }
    }

    /// Loads and prepares up to the remaining slots; what does not fit or fails is said, never dropped silently.
    private func attach(_ count: Int, load: @escaping (Int) async throws -> Data?) async {
        let (take, message) = ImagePrep.take(attached: images.count, adding: count)
        error = message
        for i in 0..<take {
            preparing += 1
            defer { preparing -= 1 }
            do {
                guard let raw = try await load(i) else { error = "An image could not be read"; continue }
                let data = try await Task.detached(priority: .userInitiated) { try ImagePrep.prepare(raw) }.value
                images.append(Attached(data: data, preview: PlatformImage(data: data)))
                #if DEBUG
                Self.debugAttached?(images.count)
                #endif
            } catch {
                self.error = "Image: \(chatErrorText(error))"
            }
        }
    }

    private func send() {
        guard canSend else { return }
        busy = true
        error = nil
        let sent = text
        let sentImages = images
        Task {
            do {
                if try await onSend(sent, sentImages.map(\.data)) {
                    // Text typed and images added while the send was in flight stay.
                    if text == sent { text = "" }
                    images.removeAll { a in sentImages.contains { $0.id == a.id } }
                }
            } catch {
                self.error = chatErrorText(error)
            }
            busy = false
        }
    }

    private func stop() {
        stopping = true
        error = nil
        Task {
            do { try await onStop() } catch { self.error = chatErrorText(error) }
            stopping = false
        }
    }
}

/// The send button drawn as its label says, pressed a little dimmer; disabled, it keeps the label's own empty look.
private struct SendButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.opacity(configuration.isPressed ? 0.7 : 1)
    }
}

#if os(iOS)
extension UIResponder {
    private static weak var found: UIResponder?
    @objc private func devboxReportFirstResponder() { UIResponder.found = self }
    /// The app's first responder: an action sent to nil goes to it.
    static func devboxFirstResponder() -> UIResponder? {
        found = nil
        UIApplication.shared.sendAction(#selector(devboxReportFirstResponder), to: nil, from: nil, for: nil)
        return found
    }
}
#endif

/// The message field, reporting its caret: TextField's selection from iOS 18 and macOS 15, placed after a pick
/// (`setCaret`). Before those, the field does not say: an edit at the end puts it at the end, any other edit makes it
/// unknown (ComposerTriggers.caretAfterEdit), and on the Mac the field editor's selection says where a click or an
/// arrow key put it.
struct CaretField: View {
    @Binding var text: String
    @Binding var caret: Int?
    @Binding var setCaret: Int?
    let prompt: Text
    #if DEBUG
    /// Tests take the older systems' path on a newer one.
    static var debugWithoutSelection = false
    #endif

    var body: some View {
        if #available(iOS 18, macOS 15, *), !Self.withoutSelection {
            SelectionField(text: $text, caret: $caret, setCaret: $setCaret, prompt: prompt)
        } else {
            TextField("Message", text: $text, prompt: prompt, axis: .vertical)
                .onChange(of: text) { old, new in caret = ComposerTriggers.caretAfterEdit(from: old, to: new) }
                .onChange(of: setCaret) { _, c in if c != nil { setCaret = nil } }
                #if os(macOS)
                .onReceive(NotificationCenter.default.publisher(for: NSTextView.didChangeSelectionNotification)) { n in
                    // A focused editor holding this composer's text: the notification names no SwiftUI field. A
                    // selection change inside an edit comes before the text change, which then decides.
                    guard let editor = n.object as? NSTextView, editor.window?.firstResponder === editor,
                          editor.string == text else { return }
                    caret = editor.selectedRange().location
                }
                #endif
        }
    }

    private static var withoutSelection: Bool {
        #if DEBUG
        debugWithoutSelection
        #else
        false
        #endif
    }
}

@available(iOS 18, macOS 15, *)
private struct SelectionField: View {
    @Binding var text: String
    @Binding var caret: Int?
    @Binding var setCaret: Int?
    let prompt: Text
    @State private var selection: TextSelection?

    var body: some View {
        TextField("Message", text: $text, selection: $selection, prompt: prompt, axis: .vertical)
            .onChange(of: selection) { _, s in if let o = Self.offset(s, in: text) { caret = o } }
            // The text can change before the selection does: read the caret again against the new text.
            .onChange(of: text) { _, t in if let o = Self.offset(selection, in: t) { caret = o } }
            .onChange(of: setCaret) { _, c in
                guard let c else { return }
                setCaret = nil
                caret = c
                // After the text change lands in the field, or the field puts the caret at the end of its new text.
                DispatchQueue.main.async {
                    let i = String.Index(utf16Offset: min(c, text.utf16.count), in: text)
                    selection = TextSelection(insertionPoint: i)
                    caret = c
                }
            }
    }

    /// The caret's UTF-16 offset, a range's start; nil for several ranges (not a TextField's), which keeps the last.
    static func offset(_ s: TextSelection?, in text: String) -> Int? {
        guard let s, case let .selection(range) = s.indices,
              range.lowerBound >= text.startIndex, range.lowerBound <= text.endIndex else { return nil }
        return range.lowerBound.utf16Offset(in: text)
    }
}
