import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "devbox-firewall-"));
  const log = join(dir, "calls");
  const bin = (name: string, body: string) => writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  bin("ip", `case "$*" in
    '-o -4 route show default') printf '%s\\n' "\${ROUTE4-default via 192.0.2.1 dev ens3 proto dhcp}" ;;
    '-o -6 route show default') printf '%s\\n' "\${ROUTE6-default via fe80::1 dev enp7s0 proto ra}" ;;
    'link show dev ens3'|'link show dev enp7s0') exit 0 ;;
    *) exit 1 ;;
  esac`);
  for (const name of ["ufw", "iptables", "ip6tables"]) {
    bin(name, `printf '%s\\n' '${name}'" $*" >> "$CALL_LOG"\n[ "\${1:-}" != '-C' ]`);
  }
  bin("sshd", "echo 'port 2222'");
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, CALL_LOG: log, PUBLIC_IFACE: "" };
  return { dir, log, env };
}

test("setup preserves operator rules and denies both default-route NICs before adding allows", () => {
  const f = fixture();
  try {
    const r = Bun.spawnSync(["bash", "-c", 'source "$1/infra/setup.sh"; configure_ufw; configure_ufw', "test", root], { env: f.env });
    expect(r.exitCode).toBe(0);
    const calls = readFileSync(f.log, "utf8");
    expect(calls).not.toContain("reset");
    for (const nic of ["ens3", "enp7s0"]) for (const port of [4300, 4301, 15432, 15433]) {
      expect(calls).toContain(`ufw insert 1 deny in on ${nic} to any port ${port} proto tcp`);
    }
    expect(calls).toContain("ufw allow 2222/tcp");
    expect(calls.indexOf("ufw insert 1")).toBeLessThan(calls.indexOf("ufw allow"));
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("Docker firewall protects IPv4 and IPv6 on every selected public interface", () => {
  const f = fixture();
  try {
    const r = Bun.spawnSync(["sh", `${root}/infra/docker-user-firewall.sh`], { env: f.env });
    expect(r.exitCode).toBe(0);
    const calls = readFileSync(f.log, "utf8");
    for (const cmd of ["iptables", "ip6tables"]) {
      for (const nic of ["ens3", "enp7s0"]) expect(calls).toContain(`${cmd} -I DOCKER-USER -i ${nic} -m conntrack --ctstate NEW -j DROP`);
      expect(calls).toContain(`${cmd} -I FORWARD -j DOCKER-USER`);
    }
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("interface override is validated and absent routes fail closed before any firewall mutation", () => {
  const f = fixture();
  try {
    const run = (vars: Record<string, string>) => Bun.spawnSync(["sh", "-c", '. "$1/infra/public-interfaces.sh"; public_interfaces', "test", root], { env: { ...f.env, ...vars } });
    expect(run({ PUBLIC_IFACE: "ens3" }).stdout.toString().trim()).toBe("ens3");
    expect(run({ PUBLIC_IFACE: "   " }).exitCode).not.toBe(0);
    expect(run({ PUBLIC_IFACE: "missing0" }).exitCode).not.toBe(0);
    expect(run({ ROUTE4: "", ROUTE6: "" }).exitCode).not.toBe(0);
    expect(run({ PUBLIC_IFACE: "tailscale0" }).exitCode).not.toBe(0);
    const r = Bun.spawnSync(["bash", "-c", 'source "$1/infra/setup.sh"; configure_ufw', "test", root], { env: { ...f.env, PUBLIC_IFACE: "missing0" } });
    expect(r.exitCode).not.toBe(0);
    expect(Bun.file(f.log).size).toBe(0);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
