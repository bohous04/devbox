import { expect, test } from "bun:test";
import { join } from "node:path";

const INFRA = join(import.meta.dir, "..", "..", "infra");

test("the unit never publishes the proxy on all interfaces", async () => {
  const unit = await Bun.file(join(INFRA, "cliproxy.service")).text();
  expect(unit).not.toContain("-p 8317");          // no address = 0.0.0.0
  expect(unit).not.toContain("0.0.0.0:8317");
  expect(unit).toContain("127.0.0.1:8317:8317");
  expect(unit).toContain("__DOCKER_GW__:8317:8317");   // filled in by setup.sh
  expect(unit).toContain("cliproxy-auths");
});

// `systemctl enable` (setup.sh) writes the symlink into multi-user.target regardless of
// the contents of config.yaml — the guard in setup.sh is evaluated only AT INSTALL, not on
// every start. Without this ExecStartPre, a placeholder left in config.yaml would
// mean the proxy comes up with a publicly readable key on the next reboot.
test("the unit refuses to start the process while config.yaml has a placeholder key", async () => {
  const unit = await Bun.file(join(INFRA, "cliproxy.service")).text();
  const guard = unit.split("\n").find((l) => l.startsWith("ExecStartPre=") && l.includes("__CHANGE_ME__"));
  expect(guard).toBeDefined();
  expect(guard).toContain("/etc/devd/cliproxy/config.yaml");
  expect(guard).toMatch(/!\s*grep/);   // `!` negates grep: a found placeholder must fail ExecStartPre
});

test("setup.sh fills in the REAL docker0 gateway, not a hardcoded 172.17.0.1", async () => {
  const sh = await Bun.file(join(INFRA, "setup.sh")).text();
  expect(sh).toContain("docker network inspect bridge");
  expect(sh).toContain("__DOCKER_GW__");
  expect(sh).toContain("ufw allow in on docker0 to any port 8317");
});

function cliproxyFn(sh: string): string {
  return sh.slice(sh.indexOf("install_cliproxy()"), sh.indexOf("\ninstall_devd_watch()"));
}

test("gateway lookup survives a missing docker/bridge and does not stop the whole setup.sh", async () => {
  const sh = await Bun.file(join(INFRA, "setup.sh")).text();
  const gwLine = sh.split("\n").find((l) => l.includes("docker network inspect bridge"));
  expect(gwLine).toBeDefined();
  // under `set -euo pipefail`, without a fallback a docker failure (daemon down, missing
  // bridge network) would bring down the WHOLE setup.sh before the guard a line below gets evaluated
  expect(gwLine).toContain("|| true");
});

test("install generates a real api-keys key instead of the placeholder", async () => {
  const sh = await Bun.file(join(INFRA, "setup.sh")).text();
  const fn = cliproxyFn(sh);
  expect(fn).toContain("openssl rand -hex 32");
  expect(fn).toContain("__CHANGE_ME__");   // placeholder from example.yaml that gets replaced
  // The key is also written to a separate file that devd reads by itself —
  // that is why the install does NOT PRINT it. A printed key ends up in scrollback and transcripts.
  expect(fn).toContain("/etc/devd/cliproxy/api-key");
  expect(fn).toContain("install -m 600 /dev/null /etc/devd/cliproxy/api-key");
  expect(fn).not.toMatch(/log ".*\$key/);
});

test("cliproxy does not start while config.yaml contains the placeholder key", async () => {
  const sh = await Bun.file(join(INFRA, "setup.sh")).text();
  const lines = cliproxyFn(sh).split("\n");
  const guardLine = lines.findIndex((l) => l.includes("grep") && l.includes("__CHANGE_ME__"));
  const startLine = lines.findIndex((l) => l.includes("systemctl restart cliproxy"));
  expect(guardLine).toBeGreaterThan(-1);
  expect(startLine).toBeGreaterThan(-1);
  expect(guardLine).toBeLessThan(startLine);
});

// The guard above returns from the function, so nothing after it runs when there is a placeholder.
// `enable` must therefore come BEFORE it — otherwise the proxy does not exist after the next reboot and
// proxy profiles fail only inside cc on connection-refused instead of on a message from
// agent-launch. `enable` alone starts nothing, so the guard keeps its purpose.
test("the unit is enabled even when the placeholder does not let it start", async () => {
  const sh = await Bun.file(join(INFRA, "setup.sh")).text();
  const lines = cliproxyFn(sh).split("\n");
  const enableLine = lines.findIndex((l) => l.trim() === "systemctl enable cliproxy");
  const guardLine = lines.findIndex((l) => l.includes("grep") && l.includes("__CHANGE_ME__"));
  expect(enableLine).toBeGreaterThan(-1);
  expect(enableLine).toBeLessThan(guardLine);
});

// `enable --now` leaves a running unit alone. A repeated setup.sh run after a docker0 gateway
// change did write a new unit file, but it never took effect — the proxy kept
// running with the old address. `systemctl restart devd` a few functions above exists for the same reason.
test("a repeated setup.sh actually restarts the proxy, not just 'enable --now'", async () => {
  const fn = cliproxyFn(await Bun.file(join(INFRA, "setup.sh")).text());
  expect(fn).toContain("systemctl restart cliproxy");
  expect(fn).not.toContain("systemctl enable --now cliproxy");
});

// The key to three paid subscriptions must not be readable by others on the host even for a moment:
// neither on disk (chmod only AFTER the write = a window with umask 0644), nor in `ps` (sed had the expression
// `s#…#$key#` in argv). Also verified functionally: `sed -f -` works in both GNU and BSD sed, and a file
// created via `install -m 600` keeps its mode after redirection.
test("the generated config.yaml never sits with default permissions and the key is not in argv", async () => {
  const fn = cliproxyFn(await Bun.file(join(INFRA, "setup.sh")).text());
  expect(fn).toContain("install -m 600 /dev/null /etc/devd/cliproxy/config.yaml");
  expect(fn).toContain("sed -f -");
  expect(fn).not.toMatch(/sed\s+"s#__CHANGE_ME__#\$key#"/);   // key in argv
  expect(fn).not.toContain("chmod 600 /etc/devd/cliproxy/config.yaml");
});

// Regression: the first version of this change filled in api-key only in the "config.yaml
// does not exist" branch. On an UPGRADED machine (config already exists) the file was therefore never created
// and proxy profiles did not come up — a bug that does not show on a fresh install, i.e.
// exactly where it is most likely tested. Only the real deployment revealed it.
test("api-key is filled in on an existing install too, not only on a fresh one", async () => {
  const sh = await Bun.file(join(INFRA, "setup.sh")).text();
  const fn = cliproxyFn(sh);
  expect(fn).toContain("! -s /etc/devd/cliproxy/api-key");
  // The backfill must sit OUTSIDE the block conditioned on config.yaml not existing — otherwise it
  // gets skipped on upgrade again. We tell by the order: the api-key condition comes after
  // generating the new key, i.e. after the end of that block.
  const generateBlock = fn.indexOf("openssl rand -hex 32");
  const backfill = fn.indexOf("! -s /etc/devd/cliproxy/api-key");
  expect(generateBlock).toBeGreaterThan(-1);
  expect(backfill).toBeGreaterThan(generateBlock);
  // The placeholder must NOT be filled in — that would start the proxy with a key that is public in the repo.
  expect(fn).toContain('"__CHANGE_ME__"');
});
