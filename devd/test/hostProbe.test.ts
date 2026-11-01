import { expect, test } from "bun:test";
import { HOST_PROBE, parseHostReport } from "../src/hostProbe";

// Verbatim lines from real output on the devbox and infra.
const SAMPLE = `##host
hostname=devbox-host
uptime_s=1730436
os=Debian GNU/Linux 13 (trixie)
kernel=6.12.95+deb13-amd64
boot=2026-07-07 10:45:29
##disk
2113645285376 74035593216 /
##updates
reboot=1
rebootpkg=linux-image-amd64
cloudflared/unknown 2026.7.3 amd64 [upgradable from: 2026.6.1]
docker-ce/trixie 5:29.6.2-1~debian.13~trixie amd64 [upgradable from: 5:29.6.1-1~debian.13~trixie]
##ssh
2026-07-27T11:22:34+0200 devbox-host sshd-session[216763]: Accepted publickey for root from 203.0.113.50 port 58172 ssh2: ED25519 SHA256:0a/v6eHm
2026-07-27T11:23:29+0200 devbox-host sshd-session[228424]: Accepted password for dev from 10.0.0.9 port 58768 ssh2
##pkg
2026-07-25 06:31:12 upgrade libfoo:amd64 1.0 1.1
2026-07-27 10:21:37 install sqlite3:amd64 <none> 3.46.1-7+deb13u1
##end
`;

test("parseHostReport reads the machine identity", () => {
  const r = parseHostReport(SAMPLE);
  expect(r.hostname).toBe("devbox-host");
  expect(r.os).toBe("Debian GNU/Linux 13 (trixie)");
  expect(r.kernel).toBe("6.12.95+deb13-amd64");
  expect(r.uptimeSec).toBe(1730436);
  expect(r.bootedAt).toBe(new Date("2026-07-07T10:45:29").getTime());
});

test("disk is read in bytes", () => {
  expect(parseHostReport(SAMPLE).disk).toEqual({ totalBytes: 2113645285376, usedBytes: 74035593216 });
});

test("pending packages are split into name, old and new version", () => {
  const r = parseHostReport(SAMPLE);
  expect(r.updates).toHaveLength(2);
  expect(r.updates[0]).toEqual({ pkg: "cloudflared", from: "2026.6.1", to: "2026.7.3" });
  // A version with a colon (epoch) must not be truncated.
  expect(r.updates[1]).toEqual({ pkg: "docker-ce", from: "5:29.6.1-1~debian.13~trixie", to: "5:29.6.2-1~debian.13~trixie" });
});

test("reboot-required including the reason", () => {
  const r = parseHostReport(SAMPLE);
  expect(r.rebootRequired).toBe(true);
  expect(r.rebootPkgs).toEqual(["linux-image-amd64"]);
});

test("SSH logins: newest first, with user, IP and method", () => {
  const r = parseHostReport(SAMPLE);
  expect(r.logins).toHaveLength(2);
  expect(r.logins[0]).toEqual({
    at: new Date("2026-07-27T11:23:29+0200").getTime(),
    method: "password", user: "dev", ip: "10.0.0.9",
  });
  expect(r.logins[1].user).toBe("root");
});

test("dpkg: for upgrade the NEW version is taken, for install the only one", () => {
  const r = parseHostReport(SAMPLE);
  expect(r.packages[0]).toEqual({
    at: new Date("2026-07-27T10:21:37").getTime(),
    action: "install", pkg: "sqlite3", version: "3.46.1-7+deb13u1",
  });
  expect(r.packages[1]).toEqual({
    at: new Date("2026-07-25T06:31:12").getTime(),
    action: "upgrade", pkg: "libfoo", version: "1.1",
  });
});

test("missing sections are not an error", () => {
  const r = parseHostReport("##host\nhostname=x\n##end\n");
  expect(r.hostname).toBe("x");
  expect(r.disk).toBeNull();
  expect(r.updates).toEqual([]);
  expect(r.logins).toEqual([]);
  expect(r.packages).toEqual([]);
  expect(r.rebootRequired).toBe(false);
});

test("empty input returns an empty report", () => {
  const r = parseHostReport("");
  expect(r.hostname).toBeNull();
  expect(r.uptimeSec).toBeNull();
});

test("a machine without reboot-required and without updates", () => {
  const r = parseHostReport("##updates\nreboot=0\n##end\n");
  expect(r.rebootRequired).toBe(false);
  expect(r.updates).toEqual([]);
});

test("HOST_PROBE runs as one script, not as a series of commands", () => {
  // Regression guard: splitting into several SSH calls led, during the survey, to
  // `Connection refused`. One script must print every section the parser knows.
  for (const s of ["##host", "##disk", "##updates", "##ssh", "##pkg"]) {
    expect(HOST_PROBE).toContain(s);
  }
  expect(HOST_PROBE).toContain("apt list --upgradable");
  expect(HOST_PROBE).toContain("journalctl");
});
