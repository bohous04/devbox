import SwiftUI

/// An open request the agent waits on (dashboard/src/components/chat/RequestForm.tsx): a question (options as
/// buttons, multi-select when the request says so, free text), a plan (Approve, or reject with feedback) or an
/// approval (its options).
struct RequestFormView: View {
    /// The bridge approves a plan only on exactly this answer (PLAN_APPROVE in the agent bridge).
    static let planApprove = "Approve"

    let request: PendingRequest
    let onAnswer: (String) async throws -> Void
    @State private var text = ""
    @State private var picked: [String] = []
    @State private var busy = false
    @State private var error: String?

    private var title: String {
        switch request.kind {
        case .plan: return "Plan for approval"
        case .approval: return "Approval needed"
        case .question: return "Question"
        case .unknown: return "Request" // a kind of a later devd: answered like a question (options, free text)
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title).font(Theme.F.sectionLabel).textCase(.uppercase).tracking(0.6).foregroundStyle(Theme.C.warnText)
            ChatText(request.prompt)
            if request.kind == .plan {
                Button(Self.planApprove) { send(Self.planApprove) }.buttonStyle(.borderedProminent)
                answerField(placeholder: "What should change?", button: "Reject with feedback")
            } else {
                if let options = request.options, !options.isEmpty {
                    ForEach(options, id: \.label) { o in option(o) }
                    // Claude's AskUserQuestion takes a multi-select question's picked labels comma-separated.
                    if request.multiSelect == true {
                        Button("Send selection") { send(picked.joined(separator: ", ")) }
                            .buttonStyle(.borderedProminent).disabled(picked.isEmpty)
                    }
                }
                answerField(placeholder: "Answer in your own words", button: "Send")
            }
            if let error { Text(error).font(Theme.F.meta).foregroundStyle(Theme.C.dangerText) }
        }
        .disabled(busy)
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.C.warn.opacity(0.06), in: RoundedRectangle(cornerRadius: Theme.R.lg))
        .overlay(RoundedRectangle(cornerRadius: Theme.R.lg).strokeBorder(Theme.C.warn.opacity(0.4)))
    }

    private func option(_ o: RequestOption) -> some View {
        let multi = request.multiSelect == true
        let on = picked.contains(o.label)
        return Button {
            if multi { if on { picked.removeAll { $0 == o.label } } else { picked.append(o.label) } } else { send(o.label) }
        } label: {
            HStack(alignment: .top) {
                if multi { Image(systemName: on ? "checkmark.square.fill" : "square") }
                VStack(alignment: .leading, spacing: 2) {
                    Text(o.label)
                    if let d = o.description { Text(d).font(Theme.F.meta).foregroundStyle(Theme.C.mutedForeground) }
                }
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .buttonStyle(.bordered)
        .accessibilityAddTraits(multi && on ? .isSelected : [])
    }

    private func answerField(placeholder: String, button: String) -> some View {
        HStack {
            TextField(placeholder, text: $text, axis: .vertical).textFieldStyle(.roundedBorder).lineLimit(1...4)
            Button(button) { send(text.trimmingCharacters(in: .whitespacesAndNewlines)) }
                .buttonStyle(.bordered)
                .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
    }

    private func send(_ answer: String) {
        guard !busy, !answer.isEmpty else { return }
        busy = true
        error = nil
        Task {
            do { try await onAnswer(answer) } catch { self.error = chatErrorText(error) }
            busy = false
        }
    }
}
