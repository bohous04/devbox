// Mounts an SMB URL through NetFS with NetAuth UI disabled.
// "osascript mount volume" shows a modal "There was a problem connecting to the server" every time
// a mount fails (e.g. on a flaky train connection); this fails silently instead. Credentials still
// come from the login keychain.
import Foundation
import NetFS

let args = CommandLine.arguments
guard args.count == 2, let url = URL(string: args[1]) else {
  fputs("usage: smb-mount-noui smb://user@host/share\n", stderr)
  exit(2)
}
let openOptions = NSMutableDictionary()
openOptions[kNAUIOptionKey] = kNAUIOptionNoUI
var mountpoints: Unmanaged<CFArray>?
let rc = NetFSMountURLSync(url as CFURL, nil, nil, nil, openOptions, nil, &mountpoints)
if rc != 0 {
  fputs("mount \(args[1]) failed: \(rc)\n", stderr)
  exit(1)
}
