import { expect, test } from "bun:test";
import { join } from "node:path";

const INFRA = new URL("../../infra/", import.meta.url).pathname;

// devd runs natively on the host, so traffic from containers goes through the INPUT chain and
// ufw must allow it. Until 2026-09-04 `allow in on docker0` was enough: all sessions sat on
// the default bridge. Since dind every session has its OWN network `dind-net-<session>` (interface
// `br-…`), so the rule bound to docker0 silently dropped SYN from the container — the Stop hook
// then hung for 290 s on a curl timeout (agent "still working"), notifications did not arrive and
// the `srv`/`open`/`preview`/`db-request` shims were dead (2026-09-05). ufw has no
// interface wildcard, so traffic is allowed by SOURCE range: both default
// docker address pools (172.16.0.0/12 for the first 15 networks, then 192.168.0.0/16).
function ufwFn(sh: string): string {
  return sh.slice(sh.indexOf("configure_ufw()"), sh.indexOf("\nconfigure_docker_firewall()"));
}

test("ufw allows devd api from ALL docker bridge networks, not just docker0", async () => {
  const fn = ufwFn(await Bun.file(join(INFRA, "setup.sh")).text());
  expect(fn).toContain("ufw allow from 172.16.0.0/12 to any port 4300 proto tcp");
  expect(fn).toContain("ufw allow from 192.168.0.0/16 to any port 4300 proto tcp");
  // The old interface-bound rule is a subset of the new one (docker0 = 172.17.0.0/16);
  // keeping it would suggest that the interface is what the permission rests on.
  expect(fn).not.toContain("ufw allow in on docker0 to any port 4300");
});

// Allowing by source address without an interface would also let in a packet from the internet with
// a spoofed private address (eth0 has rp_filter=2, i.e. loose). ufw evaluates
// rules in the order written, so the explicit deny on eth0 must come BEFORE the allow.
test("deny on eth0 for devd api precedes the source-range allow", async () => {
  const lines = ufwFn(await Bun.file(join(INFRA, "setup.sh")).text()).split("\n");
  const deny = lines.findIndex((l) => l.includes("ufw deny in on eth0 to any port 4300 proto tcp"));
  const allow = lines.findIndex((l) => l.includes("ufw allow from 172.16.0.0/12 to any port 4300"));
  expect(deny).toBeGreaterThan(-1);
  expect(allow).toBeGreaterThan(-1);
  expect(deny).toBeLessThan(allow);
});

// The same trap a second time (2026-09-05): the prod-db DB proxy listens on the host address and psql
// from a container reaches it through the INPUT chain — without the rule `prod-db connect` hung silently.
test("ufw allows devd db proxy (15432) from docker bridge networks, deny on eth0 first", async () => {
  const lines = ufwFn(await Bun.file(join(INFRA, "setup.sh")).text()).split("\n");
  const deny = lines.findIndex((l) => l.includes("ufw deny in on eth0 to any port 15432 proto tcp"));
  const allow12 = lines.findIndex((l) => l.includes("ufw allow from 172.16.0.0/12 to any port 15432 proto tcp"));
  const allow16 = lines.findIndex((l) => l.includes("ufw allow from 192.168.0.0/16 to any port 15432 proto tcp"));
  expect(deny).toBeGreaterThan(-1);
  expect(allow12).toBeGreaterThan(deny);
  expect(allow16).toBeGreaterThan(deny);
});

// The same trap a third time (2026-11-01): PR #137 moved the sessions' dind networks into their own /24s
// from 10.213.0.0/16, but ufw only allowed docker's default pools to devd. New sessions therefore
// could not see devd at all — pasting images into Codex, hooks, notifications, srv and prod-db
// silently timed out ([UFW BLOCK] SRC=10.213.x.x DPT=4300). So the test takes the subnets directly
// from dind.ts: every network devd assigns to sessions must be allowed on all the ports
// it reaches from the container, and the deny on eth0 must come before it.
test("every dind session subnet may reach devd api and both DB proxies", async () => {
  const { dindSubnetCandidates } = await import("../src/dind");
  const lines = ufwFn(await Bun.file(join(INFRA, "setup.sh")).text()).split("\n");
  const allowed = lines.flatMap((l) => {
    const m = /ufw allow from (\d+\.\d+\.\d+\.\d+)\/(\d+) to any port (\d+) proto tcp/.exec(l);
    return m ? [{ net: m[1]!, bits: Number(m[2]), port: Number(m[3]), line: lines.indexOf(l) }] : [];
  });
  const toInt = (ip: string) => ip.split(".").reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;
  const covers = (net: string, bits: number, ip: string) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return ((toInt(net) & mask) >>> 0) === ((toInt(ip) & mask) >>> 0);
  };
  for (const port of [4300, 15432, 15433]) {
    const deny = lines.findIndex((l) => l.includes(`ufw deny in on eth0 to any port ${port} proto tcp`));
    expect(deny).toBeGreaterThan(-1);
    for (const subnet of dindSubnetCandidates("dev-acme-web")) {
      const ip = subnet.replace(/\.0\/24$/, ".3");
      const rule = allowed.find((a) => a.port === port && covers(a.net, a.bits, ip));
      expect(rule ? `${subnet} → ${port}` : `${subnet} → ${port} NOT ALLOWED`).toBe(`${subnet} → ${port}`);
      expect(rule!.line).toBeGreaterThan(deny);
    }
  }
});
