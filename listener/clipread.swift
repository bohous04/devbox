// Native clipboard read via NSPasteboard — orders of magnitude faster than the osascript
// «class PNGf» coercion (fullscreen screenshot: 1.6 s → 0.01 s). Compiled by
// listener/install.ts via swiftc; when missing, actions.ts falls back to osascript.
//
//   clipread targets                 → clipboard types, one per line (exit 1 = empty)
//   clipread text                    → clipboard text to stdout (exit 1 = none)
//   clipread image <path>            → writes PNG to <path> (exit 1 = no image)
//   clipread file <path> <maxBytes>  → writes the pasteboard file's bytes to <path>,
//                                       prints the basename (exit 1 = none, 3 = write failed,
//                                       4 = over maxBytes)
import AppKit

let pb = NSPasteboard.general
let args = CommandLine.arguments
let mode = args.count > 1 ? args[1] : "image"

switch mode {
case "targets":
  var t = [String]()
  if pb.data(forType: .png) != nil || pb.data(forType: .tiff) != nil { t.append("image/png") }
  let fileUrls = pb.readObjects(forClasses: [NSURL.self],
                                options: [.urlReadingFileURLsOnly: true]) as? [URL]
  if let f = fileUrls, !f.isEmpty {
    t.append("application/x-devbox-file")
    t.append("text/plain") // so cc asks for text/plain → the shim switches to /file
  } else if let s = pb.string(forType: .string), !s.isEmpty {
    t.append("text/plain")
  }
  if t.isEmpty { exit(1) }
  print(t.joined(separator: "\n"))

case "text":
  guard let s = pb.string(forType: .string), !s.isEmpty else { exit(1) }
  FileHandle.standardOutput.write(s.data(using: .utf8) ?? Data())

case "image":
  guard args.count > 2 else { exit(2) } // missing target path
  var data = pb.data(forType: .png)
  if data == nil, let tiff = pb.data(forType: .tiff), let rep = NSBitmapImageRep(data: tiff) {
    data = rep.representation(using: .png, properties: [:])
  }
  guard let d = data, d.count > 0 else { exit(1) }
  do { try d.write(to: URL(fileURLWithPath: args[2])) } catch { exit(3) }

case "file":
  // clipread file <outpath> <maxBytes> — writes the pasteboard file's bytes to <outpath>,
  // prints the basename. Serves ONLY the file from the pasteboard (not a path from outside).
  guard args.count > 3 else { exit(2) }
  let outPath = args[2]
  let maxBytes = Int(args[3]) ?? 0
  guard let urls = pb.readObjects(forClasses: [NSURL.self],
                                  options: [.urlReadingFileURLsOnly: true]) as? [URL],
        let u = urls.first else { exit(1) }
  let size = (try? FileManager.default.attributesOfItem(atPath: u.path)[.size] as? Int) ?? nil
  if let sz = size, sz > maxBytes { exit(4) }
  guard let data = try? Data(contentsOf: u) else { exit(1) }
  if data.count > maxBytes { exit(4) }
  do { try data.write(to: URL(fileURLWithPath: outPath)) } catch { exit(3) }
  print(u.lastPathComponent)

default:
  exit(2)
}
