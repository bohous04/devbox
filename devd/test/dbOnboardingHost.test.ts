import { expect, test } from "bun:test";
import { readFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbOnboardingHost, validateHostPlan, validateSshPolicy, type HostDeps } from "../src/dbOnboardingHost";
import { onboardingAccountIdentityScript, onboardingAccountSetupScript, onboardingDependencyScript, onboardingInspectionScript, onboardingInstallScript, onboardingRoleSql, onboardingVerifySql, scramVerifier } from "../src/dbOnboardingScripts";
import type { OnboardingPlan } from "../src/dbOnboarding";
import type { RunOpts } from "../src/proc";
import { run } from "../src/proc";

function plan(): OnboardingPlan {
  const trustedServer = { host: "192.0.2.11", port: 2222, user: "main", key: "prod-tunnel-test", adminKey: "test-root-hardened", adminUser: "root", opVault: "vault" };
  const input = { sshAlias: "ignored-malicious-alias", container: "pg-isolated", engine: "postgres" as const, db: "fixture", roUser: "fixture_ro", hostPort: 15577, opItem: "prod-ro fixture" };
  const entry = { ...input, name: "fixture", server: "test", tunnelUser: "devbox-db-tunnel", tunnelKey: trustedServer.key };
  return { requestId: 10, entry, input, trustedServer, server: { ...trustedServer, user: entry.tunnelUser }, write: false, migrations: false, changes: [], fingerprint: "fixture-fingerprint" };
}
/** Admin/tunnel SSH steps that run a script; excludes shared-connection control calls. */
const sshSteps = (f: { calls: { cmd: string[]; opts: RunOpts }[] }) => f.calls.filter(c => c.cmd[0] === "ssh" && !c.cmd.includes("-M") && !c.cmd.includes("-O"));
function harness(p = plan()) {
  const items: { id: string; title: string; category: string; vault: { id: string; name: string } }[] = [{ id: "admin", title: "test-root-hardened", category: "SSH_KEY", vault: { id: "vault", name: "vault" } }];
  const secrets = new Map([["admin", "-----BEGIN PRIVATE KEY-----\nADMIN-TEST-SECRET\n-----END PRIVATE KEY-----"]]);
  const calls: { cmd: string[]; opts: RunOpts }[] = []; let creates = 0; let verified = 0; let failRoles = false; let sshFail = false; let opFail = false; let canCreate: boolean | undefined = true; let ownerSafe = true; let busy = false; let missingTools = "";
  const keyPaths: string[] = [];
  const result = (stdout = "", code = 0, stderr = "") => ({ code, stdout, stderr, timedOut: false });
  const deps: HostDeps = {
    token: () => "HOST-ONLY-SERVICE-TOKEN",
    catalog: () => ({ servers: { test: p.trustedServer }, databases: [] }), proxyReady: () => true,
    canCreateItems: async () => canCreate,
    portFree: async () => !busy,
    verifyDatabase: async (_plan, password) => { expect(password).toBe("host-only-password-1"); verified++; },
    run: async (cmd, opts) => {
      calls.push({ cmd, opts });
      if (cmd[0] === "op") {
        if (opFail) return result("", 1, "token=SHOULD-NOT-LEAK");
        if (cmd[1] === "item" && cmd[2] === "list") return result(JSON.stringify(items));
        if (cmd[1] === "read") return result(secrets.get(cmd[2]!.split("/")[3]!)!);
        if (cmd[1] === "item" && cmd[2] === "create") {
          const title = cmd[cmd.indexOf("--title") + 1]!; const category = cmd[cmd.indexOf("--category") + 1] === "ssh" ? "SSH_KEY" : "PASSWORD";
          const id = String(++creates); items.push({ id, title, category, vault: { id: "vault", name: "vault" } });
          secrets.set(id, category === "SSH_KEY" ? "-----BEGIN PRIVATE KEY-----\nTUNNEL-TEST-SECRET\n-----END PRIVATE KEY-----" : "host-only-password-1");
          return result(JSON.stringify({ id, secret: "never-expose-create-result" }));
        }
      }
      if (cmd[0] === "ssh-keygen") {
        const path = cmd[cmd.indexOf("-f") + 1]!; keyPaths.push(path);
        return result(readFileSync(path, "utf8").includes("ADMIN") ? "ssh-ed25519 QUFBQQ==" : "ssh-ed25519 QkJCQg==");
      }
      if (cmd[0] === "ssh") {
        if (sshFail) return result("", 255, "password=SSH-LEAK");
        if (opts.stdin?.includes("printf 'RUNNING='")) return result([
          `MISSING_TOOLS=${missingTools}`, "RUNNING=true", 'IMAGE="postgres:17"', 'NETWORKS={"private":{"IPAddress":"172.18.0.4"}}', 'PORTS={"5432/tcp":null}', "PORT_BUSY=no", "RELAY_MANAGED=no", "SYSTEMD=yes", "PROXY_BINARY=/usr/lib/systemd/systemd-socket-proxyd", "SSHD=yes", "USER_CONFLICT=no", "SSH_INCLUDE=yes", "SSH_SCOPED_ALLOW=yes", "CLIENT_ADDRESS=192.0.2.22", `SSH_EFFECTIVE=${Buffer.from("pubkeyauthentication yes\nauthenticationmethods any\nauthorizedkeysfile .ssh/authorized_keys .ssh/authorized_keys2\n").toString("base64")}`,
          `DATABASE=${JSON.stringify({ db: p.entry.db, owner: "fixture_owner", ownerSafe, ownerOwnsTables: true, roles: [] })}`,
        ].join("\n"));
        if (opts.stdin?.includes("DO $devd$") && failRoles) { failRoles = false; return result("", 1, "PASSWORD SECRET devd role_conflict"); }
        return result("ok");
      }
      throw new Error(`Unexpected test command: ${cmd.join(" ")}`);
    },
  };
  const host = createDbOnboardingHost(deps);
  return { host, deps, calls, items, secrets, keyPaths, get creates() { return creates; }, get verified() { return verified; }, set failRoles(v: boolean) { failRoles = v; }, set sshFail(v: boolean) { sshFail = v; }, set opFail(v: boolean) { opFail = v; }, set canCreate(v: boolean | undefined) { canCreate = v; }, set ownerSafe(v: boolean) { ownerSafe = v; }, set busy(v: boolean) { busy = v; }, set missingTools(v: string) { missingTools = v; } };
}

test("unsupported engine never consumes a 1Password request", async () => {
  const f = harness(), p = plan();
  p.entry.engine = "mysql";
  const blocks = await f.host.preflight(p);
  expect(blocks.some(b => b.code === "unsupported_engine")).toBe(true);
  expect(f.calls).toHaveLength(0);
});

test("quota rejection pauses repeated preflight calls and preserves a safe actionable block", async () => {
  const f = harness(); let calls = 0;
  const host = createDbOnboardingHost({ ...f.deps, run: async cmd => {
    calls++;
    if (cmd[1] === "service-account") return { code: 0, stdout: '[{"remaining":0,"reset":1200}]', stderr: "", timedOut: false };
    return { code: 1, stdout: "", stderr: "SECRET rate-limited", timedOut: false };
  } });
  for (let i = 0; i < 3; i++) {
    const blocks = await host.preflight(plan());
    expect(blocks.some(b => b.code === "op_rate_limited" && b.category === "connection")).toBe(true);
    expect(JSON.stringify(blocks)).not.toContain("SECRET");
  }
  expect(calls).toBe(2);
});

test("preflight reports 1Password manual items and unavailable local port together without creating secrets", async () => {
  const f = harness(); f.canCreate = false; f.busy = true;
  const blocks = await f.host.preflight(plan());
  expect(blocks.map(b => b.code)).toContain("local_port_busy");
  expect(blocks.find(b => b.code === "op_manual_items")?.message).toContain("prod-tunnel-test");
  expect(f.creates).toBe(0);
  expect(sshSteps(f).every(c => c.opts.stdin?.includes("printf 'RUNNING='"))).toBe(true);
});

test("unknown 1Password write permission fails closed and available manual items resume the same plan", async () => {
  const f = harness(); f.canCreate = undefined;
  expect((await f.host.preflight(plan())).some(b => b.code === "op_manual_items")).toBe(true);
  f.items.push({ id: "manual-key", title: "prod-tunnel-test", category: "SSH_KEY", vault: { id: "vault", name: "vault" } }, { id: "manual-password", title: "prod-ro fixture", category: "PASSWORD", vault: { id: "vault", name: "vault" } });
  f.secrets.set("manual-key", "-----BEGIN PRIVATE KEY-----\nTUNNEL-TEST-SECRET\n-----END PRIVATE KEY-----"); f.secrets.set("manual-password", "host-only-password-1");
  await f.host.execute(plan()); await f.host.verify(plan());
  expect(f.creates).toBe(0); expect(f.verified).toBe(1);
});

test("host setup creates dedicated items once, uses only fixed SSH and never passes secrets in argv", async () => {
  const f = harness(); const progress: string[] = [];
  await f.host.execute(plan(), step => progress.push(step)); await f.host.verify(plan());
  expect(f.creates).toBe(2); expect(f.verified).toBe(1); expect(progress.at(-1)).toBe("database_roles_ready");
  expect(JSON.stringify(f.calls.map(c => c.cmd))).not.toMatch(/HOST-ONLY|ADMIN-TEST|TUNNEL-TEST|host-only-password|ignored-malicious/);
  expect(sshSteps(f).map(c => c.opts.stdin ?? "").join("\n")).not.toContain("host-only-password-1");
  expect(f.keyPaths.every(p => !existsSync(p))).toBe(true);
  await f.host.execute(plan()); await f.host.verify(plan()); expect(f.creates).toBe(2); expect(f.verified).toBe(2);
});

test("concurrent retries share deterministic items and recover after partial role setup failure", async () => {
  const f = harness(); f.failRoles = true;
  await expect(f.host.execute(plan())).rejects.toMatchObject({ block: { code: "role_conflict" } });
  expect(f.creates).toBe(2); expect(f.verified).toBe(0);
  await Promise.all([f.host.execute(plan()), f.host.execute(plan())]);
  expect(f.creates).toBe(2); expect(f.verified).toBe(0);
});

test("1Password and SSH failures are classified without leaking their stderr", async () => {
  const f = harness(); f.opFail = true;
  let blocks = await f.host.preflight(plan()); expect(blocks[0]?.code).toBe("op_unavailable"); expect(JSON.stringify(blocks)).not.toContain("SHOULD-NOT-LEAK");
  f.opFail = false; f.sshFail = true;
  blocks = await f.host.preflight(plan()); expect(blocks.some(b => b.code === "ssh_failed")).toBe(true); expect(JSON.stringify(blocks)).not.toContain("SSH-LEAK");
});

test("1Password service-account child unsets inherited Connect variables instead of passing empty values", async () => {
  const dir = mkdtempSync(join(tmpdir(), "devd-op-env-test-"));
  const names = ["OP_CONNECT_HOST", "OP_CONNECT_TOKEN"] as const;
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const cli = join(dir, "op");
  writeFileSync(cli, `#!/bin/sh
# Match op's presence-based Connect-mode selection, including empty values.
if [ "\${OP_CONNECT_HOST+x}" = x ] || [ "\${OP_CONNECT_TOKEN+x}" = x ]; then
  echo "op item list doesn't work with Connect. Please unset OP_CONNECT_HOST and OP_CONNECT_TOKEN" >&2
  exit 61
fi
[ "$OP_SERVICE_ACCOUNT_TOKEN" = fixture-service-only ] || exit 62
[ "$1 $2" = 'item list' ] || exit 63
printf '[]'
`, { mode: 0o700 });
  try {
    const empty = await run([cli, "item", "list"], { env: { OP_CONNECT_HOST: "", OP_CONNECT_TOKEN: "", OP_SERVICE_ACCOUNT_TOKEN: "fixture-service-only" }, timeoutMs: 5000 });
    expect(empty.code).toBe(61);
    for (const inherited of ["", "inherited-connect-configuration"]) {
      for (const name of names) process.env[name] = inherited;
      const f = harness();
      const commands: string[][] = [];
      const host = createDbOnboardingHost({ ...f.deps, token: () => "fixture-service-only", run: async (cmd, opts) => {
        commands.push(cmd);
        expect(cmd[0]).toBe("op");
        return run([cli, ...cmd.slice(1)], opts);
      } });
      const blocks = await host.preflight(plan());
      // An empty inventory reaches the missing-admin check; a Connect-mode
      // failure would stop earlier with op_unavailable.
      expect(blocks.map(b => b.code)).toEqual(["admin_key_missing"]);
      expect(JSON.stringify(commands)).not.toContain("fixture-service-only");
      expect(JSON.stringify(blocks)).not.toContain("fixture-service-only");
      for (const name of names) expect(process.env[name]).toBe(inherited);
    }
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("DDL permission is a distinct early blocker and never borrows an administrator role", async () => {
  const p = plan(); p.migrations = true; p.entry.migrationUser = "fixture_migrate"; p.entry.migrationOpItem = "prod-migrate fixture";
  const f = harness(p); f.ownerSafe = false;
  expect((await f.host.preflight(p)).some(b => b.code === "ddl_owner")).toBe(true);
  await expect(f.host.execute(p)).rejects.toMatchObject({ block: { code: "ddl_owner" } });
  expect(f.creates).toBe(0);
});

test("host rejects changed target, unsafe identifiers, user and reused admin key before commands", async () => {
  const p = plan(); const catalog = { servers: { test: p.trustedServer }, databases: [] };
  expect(validateHostPlan({ ...p, entry: { ...p.entry, server: "apps-fixture" } }, catalog).map(b => b.code)).toContain("unknown_server");
  expect(validateHostPlan({ ...p, input: { ...p.input, container: "x; touch /tmp/pwn" } }, catalog).map(b => b.code)).toContain("invalid_container");
  expect(validateHostPlan({ ...p, server: { ...p.server, host: "198.51.100.1", user: "root", key: p.server.adminKey! } }, catalog).map(b => b.code)).toEqual(expect.arrayContaining(["server_mismatch", "unsafe_tunnel_user", "unsafe_tunnel_key"]));
});

test("exact server-key convention is discovered and verified over read-only SSH, never project aliases", async () => {
  const p = plan(); delete p.server.adminKey; delete p.trustedServer.adminKey;
  const f = harness(p);
  expect(await f.host.preflight(p)).toEqual([]);
  expect(sshSteps(f)[0]?.cmd).toContain("root@192.0.2.11");
});

test("fixed remote scripts are valid bash and describe all restricted resources", async () => {
  const p = plan();
  for (const script of [onboardingInspectionScript(p), onboardingInstallScript(p, "ssh-ed25519 QkJCQg==", [15577, 15578])]) {
    expect((await run(["bash", "-n"], { stdin: script, timeoutMs: 5000 })).code).toBe(0);
  }
  const script = onboardingInstallScript(p, "ssh-ed25519 QkJCQg==", [15577]);
  expect(script).toContain("AllowTcpForwarding local"); expect(script).toContain("AllowStreamLocalForwarding no");
  expect(script).toContain("ProtectSystem=strict");
  expect(script).toContain('chmod 0644 "$managed_user/.ssh/authorized_keys"');
  expect(script).not.toContain("docker restart"); expect(script).toContain("sshd -t"); expect(script).toContain("127.0.0.1:15577");
});

test("missing host commands block preparation and execution before any secret or account creation", async () => {
  const f = harness(); f.missingTools = "flock,useradd,systemd-socket-proxyd>=246";
  const blocks = await f.host.preflight(plan());
  expect(blocks).toHaveLength(1);
  expect(blocks[0]).toMatchObject({ code: "host_tools_missing", category: "configuration" });
  expect(blocks[0]!.message).toContain("flock, useradd, systemd-socket-proxyd>=246");
  await expect(f.host.execute(plan())).rejects.toMatchObject({ block: { code: "host_tools_missing" } });
  expect(f.creates).toBe(0);
  expect(sshSteps(f).every(c => c.opts.stdin?.includes("printf 'RUNNING='"))).toBe(true);
});

test("dependency probe detects missing tools and unsupported relay versions before install mutates anything", async () => {
  const dir = mkdtempSync(join(tmpdir(), "devd-host-deps-test-"));
  try {
    const proxy = join(dir, "proxy");
    writeFileSync(proxy, "#!/bin/sh\nprintf '%s\\n' '--exit-idle-time=TIME'\n", { mode: 0o700 });
    const prefix = `set -eu\ncommand() { if [ "$1" = -v ]; then [ "$2" != "$MISSING_BIN" ]; else builtin command "$@"; fi; }\n`;
    const adapt = (script: string) => script.replaceAll("/usr/lib/systemd/systemd-socket-proxyd", proxy).replaceAll("/lib/systemd/systemd-socket-proxyd", proxy).replaceAll("/usr/sbin/nologin", proxy);
    const probe = await run(["bash", "-s"], { stdin: prefix + adapt(onboardingDependencyScript()), env: { MISSING_BIN: "flock" }, timeoutMs: 5000 });
    expect(probe.code).toBe(0); expect(probe.stdout.trim()).toBe("MISSING_TOOLS=flock");
    const install = await run(["bash", "-s"], { stdin: prefix + adapt(onboardingInstallScript(plan(), "ssh-ed25519 QkJCQg==", [15577])), env: { MISSING_BIN: "useradd" }, timeoutMs: 5000 });
    expect(install.code).toBe(1); expect(install.stdout).toContain("MISSING_TOOLS=useradd\nBLOCK:host_tools_missing");
    writeFileSync(proxy, "#!/bin/sh\nprintf '%s\\n' 'old proxy help'\n", { mode: 0o700 });
    const old = await run(["bash", "-s"], { stdin: prefix + adapt(onboardingDependencyScript()), env: { MISSING_BIN: "none" }, timeoutMs: 5000 });
    expect(old.code).toBe(0); expect(old.stdout.trim()).toBe("MISSING_TOOLS=systemd-socket-proxyd>=246");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("account setup resumes after atomic useradd and refuses foreign identity despite a filesystem marker", async () => {
  const dir = mkdtempSync(join(tmpdir(), "devd-host-account-test-"));
  // Only getent/id/useradd/usermod/install are replaced. The generated account
  // setup runs in bash against a synthetic passwd database and temporary home.
  const prefix = `set -eu
getent() { case "$1" in passwd|group) [ -f "$FIXTURE_DIR/$1" ] && cat "$FIXTURE_DIR/$1";; *) return 1;; esac; }
id() { [ "$1" = -G ] && printf '%s\\n' "\${FIXTURE_GROUPS:-731}"; }
useradd() {
  printf 'devbox-db-tunnel:x:731:731:%s:%s:/usr/sbin/nologin\\n' "$account_marker" "$managed_user" > "$FIXTURE_DIR/passwd"
  printf 'devbox-db-tunnel:x:731:\\n' > "$FIXTURE_DIR/group"
  printf 'created\\n' >> "$FIXTURE_DIR/creates"
}
usermod() {
  if [ -f "$FIXTURE_DIR/interrupt" ]; then rm "$FIXTURE_DIR/interrupt"; return 19; fi
  printf 'secured\\n' >> "$FIXTURE_DIR/secured"
}
install() {
  local args=()
  while [ "$#" -gt 0 ]; do case "$1" in -o|-g) shift 2;; *) args+=("$1"); shift;; esac; done
  /usr/bin/install "\${args[@]}"
}
`;
  const adapt = (script: string) => script.replaceAll("/var/lib/devbox-db-tunnel", dir + "/home");
  const exec = (script: string, extra: Record<string, string> = {}) => run(["bash", "-s"], { stdin: prefix + adapt(script), env: { FIXTURE_DIR: dir, ...extra }, timeoutMs: 5000 });
  try {
    writeFileSync(join(dir, "interrupt"), "");
    const partial = await exec(onboardingAccountSetupScript(plan()));
    expect(partial.code).toBe(19);
    expect(existsSync(join(dir, "home/.devd-managed"))).toBe(false);
    // The same preflight identity check recognizes the account even before
    // its home/late marker exists, and the retry does not call useradd twice.
    expect((await exec(onboardingAccountIdentityScript(plan()) + "devd_account_owned\n")).code).toBe(0);
    const retry = await exec(onboardingAccountSetupScript(plan()));
    expect(retry.code).toBe(0);
    expect(readFileSync(join(dir, "creates"), "utf8")).toBe("created\n");
    expect(existsSync(join(dir, "home/.devd-managed"))).toBe(true);
    expect((await exec(onboardingAccountIdentityScript(plan()) + "devd_account_owned\n", { FIXTURE_GROUPS: "731 0" })).code).toBe(1);
    const ownRecord = readFileSync(join(dir, "passwd"), "utf8");
    writeFileSync(join(dir, "passwd"), ownRecord.replace(/devd-db-tunnel-[a-f0-9]+/, "unrelated service account"));
    const foreign = await exec(onboardingAccountSetupScript(plan()));
    expect(foreign.code).toBe(1); expect(foreign.stdout).toContain("BLOCK:tunnel_user_conflict");
    expect(readFileSync(join(dir, "secured"), "utf8")).toBe("secured\n");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("SQL contains SCRAM verifier, real RO grants and scope-specific migration privileges", () => {
  const p = plan(); const sql = onboardingRoleSql(p, { fixture_ro: "NEVER-CROSS-HOST" });
  expect(sql).not.toContain("NEVER-CROSS-HOST"); expect(sql).toContain("SCRAM-SHA-256$4096:");
  expect(sql).toContain("default_transaction_read_only=on"); expect(sql).not.toContain("INSERT, UPDATE, DELETE");
  expect(onboardingVerifySql(p)).toContain("has_table_privilege");
  expect(scramVerifier("abc", Buffer.alloc(16))).toBe(scramVerifier("abc", Buffer.alloc(16)));
  p.entry.migrationUser = "fixture_migrate"; p.entry.migrationOpItem = "prod-migrate fixture";
  const migrationSql = onboardingRoleSql(p, { fixture_ro: "a", fixture_migrate: "b" });
  expect(migrationSql).toContain("owner_row.rolsuper"); expect(migrationSql).toContain("devd ddl_owner");
  expect(migrationSql.indexOf('CREATE ROLE "fixture_migrate"')).toBeLessThan(migrationSql.lastIndexOf('ALTER DEFAULT PRIVILEGES FOR ROLE "fixture_migrate"'));
});


test("early SSH policy validation uses real client CIDR, reports allowlist, auth and key-path blockers together", () => {
  const p = plan();
  const target = { sshInclude: false, sshScopedAllow: false, clientAddress: "192.0.2.22", sshEffective: "pubkeyauthentication no\nauthenticationmethods publickey,password\nauthorizedkeysfile /etc/ssh/keys/%u\nallowusers root main\ndenyusers devbox-db-*@192.0.2.0/24\n" };
  expect(validateSshPolicy(p, target).map(b => b.code)).toEqual(expect.arrayContaining(["sshd_include_missing", "ssh_pubkey_disabled", "ssh_additional_auth", "ssh_authorized_keys_path", "ssh_user_not_allowed", "ssh_user_denied"]));
  target.sshInclude = true;
  target.sshEffective = "pubkeyauthentication yes\nauthenticationmethods publickey\nauthorizedkeysfile .ssh/authorized_keys\nallowusers devbox-db-*@192.0.2.0/24\n";
  expect(validateSshPolicy(p, target)).toEqual([]);
});

test("an occupied port is accepted only when the running host pool proves tunnel ownership", async () => {
  const f = harness(); f.busy = true;
  expect((await f.host.preflight(plan())).map(b => b.code)).toContain("local_port_busy");
  const host = createDbOnboardingHost({ ...f.deps, ownsTunnel: () => true });
  expect((await host.preflight(plan())).map(b => b.code)).not.toContain("local_port_busy");
});


test("a verified per-user AllowUsers extension handles hardened root/main-only hosts", () => {
  const p = plan();
  const target = { sshInclude: true, sshScopedAllow: true, clientAddress: "192.0.2.22", sshEffective: "pubkeyauthentication yes\nauthenticationmethods any\nauthorizedkeysfile .ssh/authorized_keys\nallowusers root main\n" };
  expect(validateSshPolicy(p, target)).toEqual([]);
  expect(onboardingInstallScript(p, "ssh-ed25519 QkJCQg==", [p.entry.hostPort])).toContain("Match User devbox-db-tunnel\n    AllowUsers devbox-db-tunnel");
});


test("trusted srv metadata resolves the exact admin key and preserves connection metadata through sudo", async () => {
  const p = plan(); delete p.server.adminKey; delete p.trustedServer.adminKey; delete p.server.adminUser; delete p.trustedServer.adminUser;
  const f = harness(p);
  f.items[0]!.title = "explicit-server-admin";
  const host = createDbOnboardingHost({ ...f.deps, adminKeyForServer: (name, server) => { expect(name).toBe("test"); expect(server.host).toBe("192.0.2.11"); return { title: "explicit-server-admin", user: "main" }; } });
  expect(await host.preflight(p)).toEqual([]);
  const ssh = sshSteps(f)[0]!;
  expect(ssh.cmd).toContain("main@192.0.2.11");
  expect(ssh.cmd.at(-1)).toBe('sudo -n env DEVD_SSH_CONNECTION="$SSH_CONNECTION" bash -s');
});

test("admin steps share one SSH connection so rate-limited targets see a single login", async () => {
  const f = harness(), p = plan();
  expect(await f.host.preflight(p)).toEqual([]);
  expect(await f.host.preflight(p)).toEqual([]);
  const masters = f.calls.filter(c => c.cmd[0] === "ssh" && c.cmd.includes("-M"));
  expect(masters).toHaveLength(1);
  expect(masters[0]!.cmd).toEqual(expect.arrayContaining(["-f", "-N", "ControlPersist=60"]));
  const sock = masters[0]!.cmd[masters[0]!.cmd.indexOf("-S") + 1]!;
  expect(sshSteps(f).length).toBe(2);
  expect(sshSteps(f).every(c => c.cmd.includes(sock) && c.cmd.includes("ControlMaster=no"))).toBe(true);
  expect(f.calls.filter(c => c.cmd.includes("-O") && c.cmd.includes("check"))).toHaveLength(1);
});
