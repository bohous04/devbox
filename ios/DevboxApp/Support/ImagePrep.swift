import Foundation
import ImageIO
import UniformTypeIdentifiers

/// Chat images before upload, with the dashboard's limits (dashboard/src/imageView.ts): the longest side at most
/// 2048 px and at most 4 MB, inputs over 20 MB refused, at most 10 per message (devd refuses more). Every image is
/// re-encoded as JPEG without its metadata, so EXIF (the GPS position included) never leaves the phone; a
/// transparent PNG loses its transparency (a known difference from the dashboard, which keeps PNG).
enum ImagePrep {
    static let maxImageSide = 2048
    static let maxImageBytes = 4 * 1024 * 1024
    static let maxInputBytes = 20 * 1024 * 1024
    static let maxImagesPerMessage = 10

    struct Failure: Error, CustomStringConvertible {
        let message: String
        var description: String { message }
    }

    /// The image as JPEG within the limits, or a `Failure` with the user-facing reason.
    static func prepare(_ data: Data) throws -> Data {
        if data.count > maxInputBytes {
            throw Failure(message: String(format: "The image is %.1f MB; images over 20 MB cannot be attached", Double(data.count) / 1024 / 1024))
        }
        guard let src = CGImageSourceCreateWithData(data as CFData, nil), CGImageSourceGetCount(src) > 0,
              let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any],
              let w = props[kCGImagePropertyPixelWidth] as? Int, let h = props[kCGImagePropertyPixelHeight] as? Int else {
            throw Failure(message: "The image could not be read")
        }
        var side = min(max(w, h), maxImageSide)
        // Each round shrinks by area; a few are plenty, more means the encoder does not get under 4 MB.
        for _ in 0..<4 {
            let out = try encode(src, maxSide: side)
            if out.count <= maxImageBytes { return out }
            side = max(1, Int(Double(side) * (Double(maxImageBytes) / Double(out.count)).squareRoot() * 0.9))
        }
        throw Failure(message: "The image could not be scaled down under 4 MB")
    }

    /// Decodes at most `maxSide` on the longest side (upright: the EXIF orientation is applied) and writes a JPEG
    /// with no properties copied over.
    private static func encode(_ src: CGImageSource, maxSide: Int) throws -> Data {
        let opts: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maxSide,
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary) else {
            throw Failure(message: "The image could not be read")
        }
        let out = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(out, UTType.jpeg.identifier as CFString, 1, nil) else {
            throw Failure(message: "The image could not be scaled down")
        }
        CGImageDestinationAddImage(dest, image, [kCGImageDestinationLossyCompressionQuality: 0.85] as CFDictionary)
        guard CGImageDestinationFinalize(dest) else { throw Failure(message: "The image could not be scaled down") }
        return out as Data
    }

    /// How many of `adding` images fit next to the `attached` ones, and what to tell the user about the rest.
    static func take(attached: Int, adding: Int) -> (take: Int, message: String?) {
        let take = max(0, min(adding, maxImagesPerMessage - attached))
        let left = adding - take
        return (take, left == 0 ? nil : "At most \(maxImagesPerMessage) images per message; \(left) \(left == 1 ? "was" : "were") left out")
    }

    /// Where a thread image (container path `/inbox/<id>/<name>`) is read for its thumbnail (devd/src/threadApi.ts).
    static func attachmentPath(sessionId: String, path: String) -> String {
        let name = path.split(separator: "/").last.map(String.init) ?? path
        return "/api/sessions/\(pathSegment(sessionId))/thread/attachments/\(pathSegment(name))"
    }
}
