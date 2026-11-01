// Network restriction of containers of shared / tainted sessions (final review I5).
//
// The guard in containerIdentity.ts only protects the devd API on :4300. But other paths lead out of
// the container that nobody authenticates or that trust the source network:
//   - dev ports of OTHER sessions published on DEVD_BIND_IP (the host's tailnet IP),
//   - the whole tailnet (traffic from the docker bridge is masqueraded through the host),
//   - CLIProxyAPI on :8317 (AI proxy with signed-in accounts),
//   - the prod-db DB proxy (DEVD_DB_PROXY_PORT, MariaDB DEVD_MYSQL_PROXY_PORT).
// The rules go into a dedicated DEVBOX-SHARED chain, jumped to from both INPUT (traffic to
// host processes: devd, db proxy, docker-proxy of published ports) and DOCKER-USER
// (forwarded traffic: tailnet and DNATed published ports — hence `--ctorigdst`,
// the destination BEFORE DNAT). Same mechanism as infra/docker-user-firewall.sh (DOCKER-USER is
// the only chain docker does not rewrite). On every sync the whole chain is
// rewritten according to the current set of IPs of restricted containers.
import { run, timeoutFor, type RunOpts, type RunResult } from "./proc";

export const SHARED_CHAIN = "DEVBOX-SHARED";
export const TAILNET_V4 = "100.64.0.0/10";
export const TAILNET_V6 = "fd7a:115c:a1e0::/48";
/** Tailscale MagicDNS. It lives in the tailnet, so the tailnet REJECT would kill it — and when the
 *  host's resolv.conf is managed by Tailscale (`nameserver 100.100.100.100`), docker uses it
 *  as the upstream for containers: the embedded DNS (127.0.0.11) on user-defined networks
 *  queries from the container's network and the default bridge copies the host's resolv.conf. That is why DNS
 *  (udp/tcp 53) to exactly these addresses is allowed before the REJECTs (rereview N1). Another resolver
 *  (public, the VPS provider's) is not affected by the restriction at all. */
export const MAGICDNS_V4 = "100.100.100.100";
export const MAGICDNS_V6 = "fd7a:115c:a1e0::53";
/** First rule of the chain (rereview N1, style of infra/docker-user-firewall.sh): replies to
 *  connections NOT opened by the restricted container (preview pN from devd on DEVD_BIND_IP, the owner
 *  from the tailnet to the session port) must not be rejected — the REJECTs still catch only new connections. */
export const ESTABLISHED_RULE = ["-m", "conntrack", "--ctstate", "ESTABLISHED,RELATED", "-j", "RETURN"];

export interface ShareFirewallConfig {
  /** DEVD_BIND_IP — the tailnet IP on which docker publishes session ports. */
  bindIp?: string;
  /** TCP ports of host services the restricted container must not reach (cliproxy, db proxy…). */
  blockedPorts: number[];
}

type Exec = (cmd: string[], opts: RunOpts) => Promise<RunResult>;

const isV6 = (ip: string) => ip.includes(":");
const inTailnetV4 = (ip: string) => {
  const m = /^(\d+)\.(\d+)\./.exec(ip);
  return !!m && Number(m[1]) === 100 && Number(m[2]) >= 64 && Number(m[2]) <= 127;
};

/** Rules (arguments after `-A DEVBOX-SHARED`) for one IP of a restricted container. */
export function rulesFor(ip: string, cfg: ShareFirewallConfig): string[][] {
  const v6 = isV6(ip);
  const tailnet = v6 ? TAILNET_V6 : TAILNET_V4;
  const reject = ["-j", "REJECT"];
  const dns = v6 ? MAGICDNS_V6 : MAGICDNS_V4;
  const out: string[][] = [
    ["-s", ip, "-d", dns, "-p", "udp", "--dport", "53", "-j", "RETURN"],
    ["-s", ip, "-d", dns, "-p", "tcp", "--dport", "53", "-j", "RETURN"],
    ["-s", ip, "-d", tailnet, ...reject],
    ["-s", ip, "-m", "conntrack", "--ctorigdst", tailnet, ...reject],
  ];
  const bind = cfg.bindIp?.trim();
  if (bind && isV6(bind) === v6 && !(v6 ? false : inTailnetV4(bind))) {
    out.push(["-s", ip, "-d", bind, ...reject], ["-s", ip, "-m", "conntrack", "--ctorigdst", bind, ...reject]);
  }
  const ports = [...new Set(cfg.blockedPorts.filter((p) => Number.isInteger(p) && p > 0 && p < 65536))];
  if (ports.length) {
    out.push(["-s", ip, "-p", "tcp", "-m", "multiport", "--dports", ports.join(","), ...reject]);
    for (const p of ports) out.push(["-s", ip, "-p", "tcp", "-m", "conntrack", "--ctorigdstport", String(p), ...reject]);
  }
  return out;
}

/** Rewrites the DEVBOX-SHARED chain according to `ips` (IPv4 via iptables, IPv6 via ip6tables —
 *  the latter only when there is some IPv6 address or the chain already existed). Failure → exception. */
export async function syncShareFirewall(ips: string[], cfg: ShareFirewallConfig, exec: Exec = run): Promise<void> {
  const opts = { timeoutMs: timeoutFor("DOCKER_QUERY") };
  const families: { bin: string; ips: string[] }[] = [
    { bin: "iptables", ips: ips.filter((ip) => !isV6(ip)) },
    { bin: "ip6tables", ips: ips.filter(isV6) },
  ];
  for (const f of families) {
    if (f.bin === "ip6tables" && f.ips.length === 0) {
      // Without IPv6 containers ip6tables is only flushed, if the chain exists.
      const has = await exec([f.bin, "-w", "-L", SHARED_CHAIN, "-n"], opts).catch(() => null);
      if (!has || has.code !== 0) continue;
    }
    const must = async (cmd: string[], okIf?: RegExp) => {
      const r = await exec([f.bin, "-w", ...cmd], opts);
      if (r.code !== 0 && !(okIf && okIf.test(r.stderr))) throw new Error(`${f.bin} ${cmd.join(" ")}: ${r.stderr.trim() || `code ${r.code}`}`);
    };
    await must(["-N", SHARED_CHAIN], /exists/i);
    await must(["-N", "DOCKER-USER"], /exists/i);
    for (const parent of ["INPUT", "DOCKER-USER"]) {
      const has = await exec([f.bin, "-w", "-C", parent, "-j", SHARED_CHAIN], opts);
      if (has.code !== 0) await must(["-I", parent, "1", "-j", SHARED_CHAIN]);
    }
    await must(["-F", SHARED_CHAIN]);
    await must(["-A", SHARED_CHAIN, ...ESTABLISHED_RULE]);
    for (const ip of f.ips) for (const rule of rulesFor(ip, cfg)) await must(["-A", SHARED_CHAIN, ...rule]);
  }
}

/** Sync with memory: the same set of IPs is not written again (only once per
 *  `reapplyMs`, in case someone flushed the chain meanwhile — ufw reset, docker restart).
 *  An empty set on a host where nothing was ever shared does not touch iptables at all. */
export function createShareFirewall(d: {
  ips: () => Promise<string[]>;
  cfg: ShareFirewallConfig;
  exec?: Exec;
  now?: () => number;
  reapplyMs?: number;
}) {
  let last: string | null = null;
  let lastSet = new Set<string>();
  let lastAt = 0;
  let chain: Promise<void> = Promise.resolve();
  const now = d.now ?? Date.now;
  const once = async (force: boolean) => {
    const ips = [...new Set(await d.ips())].sort();
    const key = ips.join(",");
    if (last === null && ips.length === 0 && !force) return; // never anything restricted
    if (!force && key === last && now() - lastAt < (d.reapplyMs ?? 300_000)) return;
    await syncShareFirewall(ips, d.cfg, d.exec);
    // Connections the newly restricted container opened BEFORE the restriction would survive thanks to the
    // ESTABLISHED RETURN — so its conntrack entries are dropped. Best effort: without the
    // `conntrack` tool (conntrack package) or without entries (code 1) nothing happens.
    for (const ip of ips) {
      if (lastSet.has(ip)) continue;
      await (d.exec ?? run)(["conntrack", "-D", "-s", ip], { timeoutMs: timeoutFor("DOCKER_QUERY") }).catch(() => null);
    }
    last = key; lastSet = new Set(ips); lastAt = now();
  };
  return {
    /** Serialized (two syncs at once would rewrite the chain under each other's hands). */
    sync(force = false): Promise<void> {
      const p = chain.then(() => once(force));
      chain = p.catch(() => {});
      return p;
    },
  };
}

/** Docker event listener (container start, network connect): marks the IP map as stale
 *  and syncs the firewall RIGHT AWAY, not after the 30 s poll (rereview N4) — a restarted restricted
 *  container with a new IP would otherwise be unfiltered until then, and an IP meanwhile given to another
 *  container would be restricted by mistake. A batch of events (`docker restart` = several lines) is merged
 *  into one sync after `debounceMs`. */
export function firewallOnDockerEvent(markChanged: () => void, sync: (() => void) | null, debounceMs = 200): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return () => {
    markChanged();
    if (!sync || timer) return;
    timer = setTimeout(() => { timer = null; sync(); }, debounceMs);
  };
}
