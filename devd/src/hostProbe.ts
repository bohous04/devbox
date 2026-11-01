// A single script that finds out everything about a machine that Beszel cannot: pending packages,
// reboot-required, SSH logins, package installs. It runs UNCHANGED locally
// (devbox) and via SSH (remote machine) — one source of truth, one parser.
//
// Why one script and not several commands: during investigation several quick SSH connections
// in a row ended with `Connection refused`. One run = one connection.

/** Sections are separated by `##name`; inside are `key=value` or list lines. */
export const HOST_PROBE = String.raw`set -u
echo "##host"
echo "hostname=$(hostname 2>/dev/null)"
echo "uptime_s=$(awk '{print int($1)}' /proc/uptime 2>/dev/null)"
echo "os=$(. /etc/os-release 2>/dev/null; echo "$PRETTY_NAME")"
echo "kernel=$(uname -r 2>/dev/null)"
echo "boot=$(uptime -s 2>/dev/null)"
echo "##disk"
df -B1 --output=size,used,target / 2>/dev/null | tail -n +2 | head -1
echo "##updates"
if [ -f /var/run/reboot-required ]; then echo "reboot=1"; else echo "reboot=0"; fi
cat /var/run/reboot-required.pkgs 2>/dev/null | sed 's/^/rebootpkg=/' | head -20
apt list --upgradable 2>/dev/null | tail -n +2 | head -60
echo "##ssh"
journalctl -u ssh -u sshd --since "-14 days" --no-pager -o short-iso 2>/dev/null | grep -F "Accepted " | tail -40
echo "##pkg"
grep -hE "^[0-9-]+ [0-9:]+ (install|upgrade|remove) " /var/log/dpkg.log /var/log/dpkg.log.1 2>/dev/null | tail -40
echo "##end"
`;

export interface SshLogin { at: number; user: string; ip: string; method: string }
export interface PkgEvent { at: number; action: string; pkg: string; version: string }
export interface PendingUpdate { pkg: string; from: string; to: string }

export interface HostReport {
  hostname: string | null;
  os: string | null;
  kernel: string | null;
  uptimeSec: number | null;
  bootedAt: number | null;
  disk: { totalBytes: number; usedBytes: number } | null;
  rebootRequired: boolean;
  rebootPkgs: string[];
  updates: PendingUpdate[];
  logins: SshLogin[];
  packages: PkgEvent[];
}

const EMPTY: HostReport = {
  hostname: null, os: null, kernel: null, uptimeSec: null, bootedAt: null, disk: null,
  rebootRequired: false, rebootPkgs: [], updates: [], logins: [], packages: [],
};

// `2026-07-27T11:22:34+0200 host sshd-session[216763]: Accepted publickey for root from 1.2.3.4 port 58172 ssh2: …`
const SSH_RE = /^(\S+)\s.*Accepted\s+(\S+)\s+for\s+(\S+)\s+from\s+(\S+)/;
// `cloudflared/unknown 2026.7.3 amd64 [upgradable from: 2026.6.1]`
const APT_RE = /^([^/\s]+)\/\S+\s+(\S+)\s+\S+\s+\[upgradable from:\s*([^\]]+)\]/;
// `2026-07-25 06:31:12 upgrade libfoo:amd64 1.0 1.1`
const DPKG_RE = /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)\s+(install|upgrade|remove)\s+(\S+?)(?::\S+)?\s+(\S+)(?:\s+(\S+))?/;

/**
 * Times from the dpkg log and from `uptime -s` are the machine's LOCAL time without a zone. Both machines run
 * in Europe/Prague like devd, so `new Date("… ")` parses them correctly; if that
 * ever diverged, it would show up as a shift, not a crash.
 */
const localTs = (s: string): number | null => {
  const t = new Date(s.replace(" ", "T")).getTime();
  return Number.isFinite(t) ? t : null;
};

/** Parses the HOST_PROBE output. A missing section = default value, never an exception. */
export function parseHostReport(text: string): HostReport {
  const out: HostReport = { ...EMPTY, rebootPkgs: [], updates: [], logins: [], packages: [] };
  let section = "";
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    if (line.startsWith("##")) { section = line.slice(2).trim(); continue; }
    if (line.trim() === "") continue;

    if (section === "host") {
      const eq = line.indexOf("=");
      if (eq < 0) continue;
      const key = line.slice(0, eq);
      const value = line.slice(eq + 1).trim();
      if (!value) continue;
      if (key === "hostname") out.hostname = value;
      else if (key === "os") out.os = value;
      else if (key === "kernel") out.kernel = value;
      else if (key === "uptime_s") { const n = Number(value); if (Number.isFinite(n)) out.uptimeSec = n; }
      else if (key === "boot") out.bootedAt = localTs(value);
    } else if (section === "disk") {
      const [size, used] = line.trim().split(/\s+/);
      const total = Number(size), usedB = Number(used);
      if (Number.isFinite(total) && Number.isFinite(usedB) && total > 0) out.disk = { totalBytes: total, usedBytes: usedB };
    } else if (section === "updates") {
      if (line.startsWith("reboot=")) { out.rebootRequired = line.slice(7).trim() === "1"; continue; }
      if (line.startsWith("rebootpkg=")) { const p = line.slice(10).trim(); if (p) out.rebootPkgs.push(p); continue; }
      const m = APT_RE.exec(line.trim());
      if (m) out.updates.push({ pkg: m[1], to: m[2], from: m[3].trim() });
    } else if (section === "ssh") {
      const m = SSH_RE.exec(line.trim());
      if (!m) continue;
      const at = new Date(m[1]).getTime();
      if (!Number.isFinite(at)) continue;
      out.logins.push({ at, method: m[2], user: m[3], ip: m[4] });
    } else if (section === "pkg") {
      const m = DPKG_RE.exec(line.trim());
      if (!m) continue;
      const at = localTs(m[1]);
      if (at === null) continue;
      // For `upgrade` the 4th field is the old and the 5th the new version; for install/remove only one.
      out.packages.push({ at, action: m[2], pkg: m[3], version: m[5] && m[5] !== "<none>" ? m[5] : m[4] });
    }
  }
  // Newest first — journalctl and dpkg.log are both chronological.
  out.logins.reverse();
  out.packages.reverse();
  return out;
}
