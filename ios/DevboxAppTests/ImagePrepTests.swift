import ImageIO
import UniformTypeIdentifiers
import XCTest
@testable import DevboxApp

/// Chat images before upload (dashboard/src/imageView.ts limits): at most 2048 px and 4 MB, re-encoded as JPEG
/// (which drops EXIF, GPS included), over 20 MB refused, at most 10 per message.
final class ImagePrepTests: XCTestCase {
    private func image(width: Int, height: Int, type: UTType, gps: Bool = false) throws -> Data {
        let ctx = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        // Noise, so the encoder cannot squeeze it to nothing.
        for i in stride(from: 0, to: width, by: 16) {
            ctx.setFillColor(CGColor(red: CGFloat(i % 255) / 255, green: CGFloat((i * 7) % 255) / 255, blue: 0.5, alpha: 1))
            ctx.fill(CGRect(x: i, y: 0, width: 8, height: height))
        }
        let out = NSMutableData()
        let dest = try XCTUnwrap(CGImageDestinationCreateWithData(out, type.identifier as CFString, 1, nil))
        let props: [CFString: Any] = gps ? [kCGImagePropertyGPSDictionary: [kCGImagePropertyGPSLatitude: 50.08, kCGImagePropertyGPSLatitudeRef: "N"]] : [:]
        CGImageDestinationAddImage(dest, ctx.makeImage()!, props as CFDictionary)
        XCTAssertTrue(CGImageDestinationFinalize(dest))
        return out as Data
    }

    private func info(_ data: Data) throws -> (width: Int, height: Int, type: String, props: [CFString: Any]) {
        let src = try XCTUnwrap(CGImageSourceCreateWithData(data as CFData, nil))
        let p = try XCTUnwrap(CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any])
        return (p[kCGImagePropertyPixelWidth] as! Int, p[kCGImagePropertyPixelHeight] as! Int, CGImageSourceGetType(src)! as String, p)
    }

    func testLargeImageIsScaledToTheLimitAsJpeg() throws {
        let out = try ImagePrep.prepare(try image(width: 3000, height: 1500, type: .png))
        let i = try info(out)
        XCTAssertEqual(i.type, UTType.jpeg.identifier)
        XCTAssertEqual(max(i.width, i.height), 2048)
        XCTAssertEqual(i.height, 1024)
        XCTAssertLessThanOrEqual(out.count, ImagePrep.maxImageBytes)
    }

    func testSmallJpegKeepsItsSizeButLosesItsGpsPosition() throws {
        let input = try image(width: 400, height: 300, type: .jpeg, gps: true)
        XCTAssertNotNil(try info(input).props[kCGImagePropertyGPSDictionary], "the fixture must carry GPS")
        let i = try info(try ImagePrep.prepare(input))
        XCTAssertEqual([i.width, i.height], [400, 300])
        XCTAssertNil(i.props[kCGImagePropertyGPSDictionary])
    }

    func testOver20MbIsRefusedWithTheDashboardsMessage() {
        let huge = Data(count: 21 * 1024 * 1024)
        XCTAssertThrowsError(try ImagePrep.prepare(huge)) { e in
            XCTAssertEqual((e as? ImagePrep.Failure)?.message, "The image is 21.0 MB; images over 20 MB cannot be attached")
        }
    }

    func testNotAnImageIsRefused() {
        XCTAssertThrowsError(try ImagePrep.prepare(Data("hello".utf8))) { e in
            XCTAssertEqual((e as? ImagePrep.Failure)?.message, "The image could not be read")
        }
    }

    func testTakeImagesCapsAtTen() {
        XCTAssertEqual(ImagePrep.take(attached: 8, adding: 3).take, 2)
        XCTAssertEqual(ImagePrep.take(attached: 8, adding: 3).message, "At most 10 images per message; 1 was left out")
        XCTAssertEqual(ImagePrep.take(attached: 10, adding: 2).message, "At most 10 images per message; 2 were left out")
        XCTAssertNil(ImagePrep.take(attached: 0, adding: 10).message)
    }

    func testAttachmentPathForTheThumbnailRoute() {
        XCTAssertEqual(ImagePrep.attachmentPath(sessionId: "s1", path: "/inbox/s1/ab c.jpg"), "/api/sessions/s1/thread/attachments/ab%20c.jpg")
    }
}
