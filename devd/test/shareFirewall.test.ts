import { expect, test } from "bun:test";
import { createShareFirewall, firewallOnDockerEvent, rulesFor, SHARED_CHAIN, syncShareFirewall } from "../src/shareFirewall";
import type { RunResult } from "../src/proc";

const CFG = { bindIp: "100.64.0.10", blockedPorts: [8317, 15432, 15433] };
const ok: RunResult = { code: 0, stdout: "", stderr: "", timedOut: false };

/** Fake iptables: records argv; `-C` (does the jump exist?) returns `jumps`, `-N` "exists" according to `chains`. */
function fakeExec(o: { jumps?: boolean; chains?: boolean; failOn?: string } = {}) {
  const calls: string[][] = [];
  const exec = async (cmd: string[]) => {
    calls.push(cmd);
    const a = cmd.slice(2).join(" ");
    if (o.failOn && a.includes(o.failOn)) return { ...ok, code: 4, stderr: "iptables: Permission denied" };
    if (cmd[2] === "-C") return o.jumps ? ok : { ...ok, code: 1, stderr: "Bad rule" };
    if (cmd[2] === "-N" && o.chains) return { ...ok, code: 1, stderr: "iptables: Chain already exists." };
    if (cmd[2] === "-L") return { ...ok, code: 1, stderr: "No chain/target/match by that name." };
    return ok;
  };
  return { calls, exec };
}

test("rulesFor: tailnet (also after DNAT), cliproxy and db proxy from a restricted container → REJECT", () => {
  const r = rulesFor("172.18.0.5", CFG).map((x) => x.join(" "));
  expect(r).toContain("-s 172.18.0.5 -d 100.64.0.0/10 -j REJECT");
  expect(r).toContain("-s 172.18.0.5 -m conntrack --ctorigdst 100.64.0.0/10 -j REJECT");
  expect(r).toContain("-s 172.18.0.5 -p tcp -m multiport --dports 8317,15432,15433 -j REJECT");
  expect(r).toContain("-s 172.18.0.5 -p tcp -m conntrack --ctorigdstport 8317 -j REJECT");
  // DEVD_BIND_IP is in the tailnet → the tailnet rule already covers it, no extra line.
  expect(r.some((l) => l.includes("100.64.0.10"))).toBe(false);
  // A BIND_IP outside the tailnet gets its own rules.
  const other = rulesFor("172.18.0.5", { ...CFG, bindIp: "10.0.0.2" }).map((x) => x.join(" "));
  expect(other).toContain("-s 172.18.0.5 -d 10.0.0.2 -j REJECT");
  expect(other).toContain("-s 172.18.0.5 -m conntrack --ctorigdst 10.0.0.2 -j REJECT");
  // IPv6 container → tailnet ULA.
  expect(rulesFor("fd00::5", CFG).map((x) => x.join(" "))).toContain("-s fd00::5 -d fd7a:115c:a1e0::/48 -j REJECT");
});

test("rulesFor: DNS to MagicDNS (udp/tcp 53) is allowed BEFORE the tailnet REJECT (rereview N1)", () => {
  const r = rulesFor("172.18.0.5", CFG).map((x) => x.join(" "));
  const udp = r.indexOf("-s 172.18.0.5 -d 100.100.100.100 -p udp --dport 53 -j RETURN");
  const tcp = r.indexOf("-s 172.18.0.5 -d 100.100.100.100 -p tcp --dport 53 -j RETURN");
  const firstReject = r.findIndex((l) => l.endsWith("-j REJECT"));
  expect(udp).toBeGreaterThanOrEqual(0);
  expect(tcp).toBeGreaterThanOrEqual(0);
  expect(udp).toBeLessThan(firstReject);
  expect(tcp).toBeLessThan(firstReject);
  // Another tailnet destination on port 53 is not allowed — only that one address.
  expect(r.filter((l) => l.endsWith("-j RETURN")).every((l) => l.includes("100.100.100.100"))).toBe(true);
  const v6 = rulesFor("fd00::5", CFG).map((x) => x.join(" "));
  expect(v6[0]).toBe("-s fd00::5 -d fd7a:115c:a1e0::53 -p udp --dport 53 -j RETURN");
});

test("syncShareFirewall: creates the chain, jumps from INPUT and DOCKER-USER, rewrites the chain", async () => {
  const { calls, exec } = fakeExec();
  await syncShareFirewall(["172.18.0.5"], CFG, exec);
  const v4 = calls.filter((c) => c[0] === "iptables").map((c) => c.slice(2).join(" "));
  expect(v4[0]).toBe(`-N ${SHARED_CHAIN}`);
  expect(v4).toContain(`-I INPUT 1 -j ${SHARED_CHAIN}`);
  expect(v4).toContain(`-I DOCKER-USER 1 -j ${SHARED_CHAIN}`);
  const flush = v4.indexOf(`-F ${SHARED_CHAIN}`);
  expect(flush).toBeGreaterThan(0);
  // First rule after flushing: replies (ESTABLISHED,RELATED) pass — otherwise REJECT would
  // also kill the container's reply to the pN preview / the owner's access (rereview N1).
  expect(v4[flush + 1]).toBe(`-A ${SHARED_CHAIN} -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN`);
  expect(v4.slice(flush + 2).every((l) => l.startsWith(`-A ${SHARED_CHAIN} -s 172.18.0.5`))).toBe(true);
  expect(calls.every((c) => c[1] === "-w")).toBe(true);
  // Without IPv6 containers and without an existing v6 chain, ip6tables is not changed.
  expect(calls.filter((c) => c[0] === "ip6tables").map((c) => c[2])).toEqual(["-L"]);
});

test("syncShareFirewall: an existing chain and jumps are not duplicated", async () => {
  const { calls, exec } = fakeExec({ jumps: true, chains: true });
  await syncShareFirewall([], CFG, exec);
  expect(calls.some((c) => c[2] === "-I")).toBe(false);
  expect(calls.some((c) => c[2] === "-F")).toBe(true); // empty set = flush
});

test("createShareFirewall: a missing conntrack tool does not break the sync", async () => {
  const { calls, exec } = fakeExec();
  const fw = createShareFirewall({ ips: async () => ["172.18.0.5"], cfg: CFG,
    exec: async (cmd) => (cmd[0] === "conntrack" ? Promise.reject(new Error("ENOENT")) : exec(cmd)) });
  await fw.sync();
  expect(calls.some((c) => c[2] === "-F")).toBe(true);
});

test("syncShareFirewall: iptables error → exception (the share is then not created)", async () => {
  const { exec } = fakeExec({ failOn: "-A" });
  await expect(syncShareFirewall(["172.18.0.5"], CFG, exec)).rejects.toThrow("Permission denied");
});

test("createShareFirewall: without restricted containers it does not touch iptables; does not rewrite the same set", async () => {
  const { calls, exec } = fakeExec();
  let ips: string[] = [];
  let t = 0;
  const fw = createShareFirewall({ ips: async () => ips, cfg: CFG, exec, now: () => t });
  await fw.sync();
  expect(calls).toHaveLength(0);
  ips = ["172.18.0.5"];
  await fw.sync();
  const n = calls.length;
  expect(n).toBeGreaterThan(0);
  await fw.sync();
  expect(calls.length).toBe(n); // unchanged
  t += 301_000;
  await fw.sync();
  expect(calls.length).toBeGreaterThan(n); // again after reapplyMs (in case someone flushed the chain)
  const m = calls.length;
  await fw.sync(true);
  expect(calls.length).toBeGreaterThan(m); // forced (share creation)
  // Newly restricted IP → its conntrack entries were dropped (connections opened before the restriction).
  expect(calls.filter((c) => c[0] === "conntrack")).toEqual([["conntrack", "-D", "-s", "172.18.0.5"]]);
  ips = [];
  await fw.sync();
  expect(calls.at(-1)!.slice(2).join(" ")).toBe(`-L ${SHARED_CHAIN} -n`); // shares ended → chain flushed (v4), nothing for v6
});

test("firewallOnDockerEvent: a docker event marks the map stale right away and merges a burst of events into one sync", async () => {
  let marked = 0, synced = 0;
  const on = firewallOnDockerEvent(() => { marked++; }, () => { synced++; }, 10);
  on(); on(); on();
  expect(marked).toBe(3);
  expect(synced).toBe(0);
  await new Promise((r) => setTimeout(r, 30));
  expect(synced).toBe(1);
  on();
  await new Promise((r) => setTimeout(r, 30));
  expect(synced).toBe(2);
  // Without a firewall (macOS, DEVD_SHARE_FIREWALL=0) it only marks the map.
  const noFw = firewallOnDockerEvent(() => { marked++; }, null, 10);
  noFw();
  expect(marked).toBe(5);
});
