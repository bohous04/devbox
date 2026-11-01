import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostBlock, includeFile, InstaboxSsh, needsRefresh } from "../src/instabox/ssh";
import { FakeInstaboxClient } from "./helpers/instaboxFake";

test("needsRefresh: < 2 h or unknown", () => {
  const now = 1_000_000_000;
  expect(needsRefresh(undefined, now)).toBe(true);
  expect(needsRefresh(now + 3 * 3600_000, now)).toBe(false);
  expect(needsRefresh(now + 3600_000, now)).toBe(true);
});

test("hostBlock contains the cert, known_hosts and ControlMaster", () => {
  const b = hostBlock("ibx-m_1", { host: "api.instabox.sh", port: 2222, username: "m_1" }, "/d");
  expect(b).toContain("Host ibx-m_1\n");
  expect(b).toContain("  HostName api.instabox.sh\n  Port 2222\n  User m_1\n");
  expect(b).toContain("  IdentityFile /d/id_ed25519\n");
  expect(b).toContain("  CertificateFile /d/m_1-cert.pub\n");
  expect(b).toContain("  UserKnownHostsFile /d/known_hosts\n");
  expect(b).toContain("  ControlMaster auto\n  ControlPath /d/cm-%C\n  ControlPersist 10m\n");
  expect(includeFile("/d")).toContain("Include /d/hosts/*.conf\n");
});

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "ibx-ssh-"));
  const fake = new FakeInstaboxClient();
  const ssh = new InstaboxSsh(fake, { dir, configFile: join(dir, "devd-instabox.conf") });
  return { dir, fake, ssh };
}

test("ensure creates the key, cert, host block, known_hosts and include; a second call does not certify", async () => {
  const { dir, fake, ssh } = fresh();
  expect(await ssh.ensure("m_1")).toBe("ibx-m_1");
  expect(existsSync(join(dir, "id_ed25519"))).toBe(true);
  expect(readFileSync(join(dir, "m_1-cert.pub"), "utf8")).toContain("m_1");
  expect(readFileSync(join(dir, "hosts", "m_1.conf"), "utf8")).toContain("Host ibx-m_1");
  expect(readFileSync(join(dir, "known_hosts"), "utf8")).toContain("@cert-authority");
  expect(readFileSync(join(dir, "devd-instabox.conf"), "utf8")).toContain(`Include ${dir}/hosts/*.conf`);
  await ssh.ensure("m_1");
  expect(fake.calls.filter((c) => c.startsWith("sshCredentials")).length).toBe(1);
  await ssh.ensure("m_1", true); // forced renewal (runDocker after Permission denied)
  expect(fake.calls.filter((c) => c.startsWith("sshCredentials")).length).toBe(2);
});

test("a second machine does not overwrite the first one's block; forget deletes only its own", async () => {
  const { dir, ssh } = fresh();
  await ssh.ensure("m_1");
  await ssh.ensure("m_2");
  expect(existsSync(join(dir, "hosts", "m_1.conf"))).toBe(true);
  expect(readFileSync(join(dir, "known_hosts"), "utf8").trim().split("\n").length).toBe(1); // CA line only once
  ssh.forget("m_1");
  expect(existsSync(join(dir, "hosts", "m_1.conf"))).toBe(false);
  expect(existsSync(join(dir, "m_1-cert.pub"))).toBe(false);
  expect(existsSync(join(dir, "hosts", "m_2.conf"))).toBe(true);
});

test("expiry is read from disk: a new instance (devd restart) does not re-certify a valid machine", async () => {
  const { dir, fake, ssh } = fresh();
  await ssh.ensure("m_1");
  const again = new InstaboxSsh(fake, { dir, configFile: join(dir, "devd-instabox.conf") });
  await again.ensure("m_1");
  expect(fake.calls.filter((c) => c.startsWith("sshCredentials")).length).toBe(1);
  writeFileSync(join(dir, "m_1.json"), JSON.stringify({ expiresAt: Date.now() + 60_000 }));
  await again.ensure("m_1");
  expect(fake.calls.filter((c) => c.startsWith("sshCredentials")).length).toBe(2);
});
