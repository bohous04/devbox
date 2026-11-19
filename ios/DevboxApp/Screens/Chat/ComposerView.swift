import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// Message input (dashboard/src/components/chat/Composer.tsx). A message sent while a run is active is queued by the
/// bridge and shows as queued. On a failed send the text and images stay and nothing is retried. Images picked
/// from Photos or pasted (at most 10) are scaled down and re-encoded (`ImagePrep`), previewed, and go with the
/// next message.
struct ComposerView: View {
    let running: Bool
    let onSend: (String, [Data]) async throws -> Void
    let onStop: () async throws -> Void

    private struct Attached: Identifiable {
        let id = UUID()
        let data: Data
        let preview: PlatformImage?
    }

    @State private var text = ""
    @State private var images: [Attached] = []
    @State private var picks: [PhotosPickerItem] = []
    @State private var busy = false
    @State private var stopping = false
    @State private var preparing = 0
    @State private var error: String?

    private var canSend: Bool { !busy && preparing == 0 && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

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
            HStack(alignment: .bottom, spacing: 8) {
                Menu {
                    PhotosPicker(selection: $picks, maxSelectionCount: max(1, ImagePrep.maxImagesPerMessage - images.count), matching: .images) {
                        Label("Photo library", systemImage: "photo.on.rectangle")
                    }
                    Button { pasteImages() } label: { Label("Paste image", systemImage: "doc.on.clipboard") }
                        .disabled(!ImagePasteboard.hasImages)
                } label: {
                    Image(systemName: "photo.badge.plus").frame(width: 36, height: 36)
                }
                .disabled(images.count >= ImagePrep.maxImagesPerMessage)
                .accessibilityLabel("Attach images")

                TextField(running ? "Message (queued after the current run)" : "Message the agent", text: $text, axis: .vertical)
                    .lineLimit(1...6)
                    .textFieldStyle(.roundedBorder)
                    .accessibilityLabel("Message")

                if running {
                    Button { stop() } label: { Image(systemName: "stop.fill").frame(width: 36, height: 36) }
                        .disabled(stopping)
                        .accessibilityLabel("Stop the run")
                }
                Button { send() } label: {
                    Image(systemName: "arrow.up.circle.fill").font(.system(size: 30))
                }
                .disabled(!canSend)
                .accessibilityLabel("Send")
            }
            if let error { Text(error).font(Theme.F.meta).foregroundStyle(Theme.C.dangerText) }
        }
        .onChange(of: picks) { _, items in
            guard !items.isEmpty else { return }
            picks = []
            Task { await attach(items.count) { i in try await items[i].loadTransferable(type: Data.self) } }
        }
    }

    private func pasteImages() {
        let providers = ImagePasteboard.providers()
        Task {
            await attach(providers.count) { i in
                try await withCheckedThrowingContinuation { (c: CheckedContinuation<Data?, Error>) in
                    _ = providers[i].loadDataRepresentation(forTypeIdentifier: UTType.image.identifier) { data, err in
                        if let err { c.resume(throwing: err) } else { c.resume(returning: data) }
                    }
                }
            }
        }
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
                try await onSend(sent, sentImages.map(\.data))
                // Text typed and images added while the send was in flight stay.
                if text == sent { text = "" }
                images.removeAll { a in sentImages.contains { $0.id == a.id } }
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
