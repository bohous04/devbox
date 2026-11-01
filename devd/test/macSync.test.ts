import { expect, test } from "bun:test";
import { join } from "node:path";

const IMAGE = join(import.meta.dir, "..", "..", "image");

// image/test-mac-sync.sh is otherwise a sibling shell test with no tie to `bun test` —
// it would only run when someone remembered it. The security guards (rsync
// transport, known_hosts pin, whitelists for DEVD_SESSION_ID and IOS_DIR) must
// run in CI just like everything else.
test("image/test-mac-sync.sh: the mac-sync security contract passes", async () => {
  const p = Bun.spawn(["bash", join(IMAGE, "test-mac-sync.sh")], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  expect(code, `stdout:\n${out}\nstderr:\n${err}`).toBe(0);
});
