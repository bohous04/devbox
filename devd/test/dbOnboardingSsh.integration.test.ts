/** DEVD_TEST_SSHD=1 bun test devd/test/dbOnboardingSsh.integration.test.ts
 * Runs a task-owned OpenSSH daemon on localhost under the current OS user.
 * No production SSH server, user account or authorized_keys file is touched. */
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { run } from "../src/proc";

const integration = process.env.DEVD_TEST_SSHD === "1" ? test : test.skip;
integration("actual OpenSSH: public-key auth permits only approved local forwarding and denies shell/reverse forwarding", async () => {
  // StrictModes validates authorized_keys parents. Linux /tmp is writable by
  // everyone, so keep the isolated fixture under this user's trusted home.
  const dir = mkdtempSync(join(userInfo().homedir, ".devd-ssh-fixture-"));
  const echo = createServer(socket => socket.pipe(socket));
  const listen = (server: ReturnType<typeof createServer>) => new Promise<number>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)); });
  const reservePort = async () => { const server = createServer(); const port = await listen(server); await new Promise<void>(r => server.close(() => r())); return port; };
  let daemon: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const targetPort = await listen(echo); const sshPort = await reservePort(); const localPort = await reservePort();
    for (const key of ["host", "client"]) expect((await run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", join(dir, key)], { timeoutMs: 5000 })).code).toBe(0);
    const pub = readFileSync(join(dir, "client.pub"), "utf8").trim().split(" ").slice(0, 2).join(" ");
    const authorized = join(dir, "authorized_keys");
    // The production file is root-owned. Mode 0644 lets sshd read public keys
    // after temporarily dropping to the dedicated unprivileged tunnel user.
    writeFileSync(authorized, `restrict,port-forwarding,permitopen="127.0.0.1:${targetPort}",command="/bin/false" ${pub}\n`, { mode: 0o644 });
    const config = join(dir, "sshd_config");
    writeFileSync(config, `Port ${sshPort}\nListenAddress 127.0.0.1\nHostKey ${join(dir, "host")}\nPidFile ${join(dir, "pid")}\nAuthorizedKeysFile ${authorized}\nStrictModes yes\nUsePAM no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nAuthenticationMethods publickey\nAllowUsers devd-fixture-no-such-user\nAllowTcpForwarding local\nAllowStreamLocalForwarding no\nAllowAgentForwarding no\nPermitTTY no\nX11Forwarding no\nPermitUserRC no\nPermitOpen 127.0.0.1:${targetPort}\nForceCommand /bin/false\nMatch User ${userInfo().username}\n    AllowUsers ${userInfo().username}\nMatch all\n`);
    expect((await run(["/usr/sbin/sshd", "-t", "-f", config], { timeoutMs: 5000 })).code).toBe(0);
    const effective = await run(["/usr/sbin/sshd", "-T", "-f", config, "-C", `user=${userInfo().username},host=127.0.0.1,addr=127.0.0.1`], { timeoutMs: 5000 });
    expect(effective.stdout).toContain(`allowusers ${userInfo().username}\n`);
    const daemonLog = join(dir, "sshd.log");
    daemon = Bun.spawn(["/usr/sbin/sshd", "-D", "-E", daemonLog, "-f", config], { stdout: "ignore", stderr: "ignore" });
    await Bun.sleep(250);
    const base = ["ssh", "-F", "/dev/null", "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none", "-o", "StrictHostKeyChecking=accept-new", "-o", `UserKnownHostsFile=${join(dir, "known_hosts")}`, "-i", join(dir, "client"), "-p", String(sshPort), `${userInfo().username}@127.0.0.1`];
    const socket = join(dir, "control");
    const connected = await run([...base, "-M", "-S", socket, "-f", "-N", "-o", "ExitOnForwardFailure=yes", "-L", `127.0.0.1:${localPort}:127.0.0.1:${targetPort}`], { timeoutMs: 8000 });
    expect(connected.code, connected.stderr + readFileSync(daemonLog, "utf8")).toBe(0);
    try {
      const response = await new Promise<string>((resolve, reject) => {
        Bun.connect({ hostname: "127.0.0.1", port: localPort, socket: { open(s) { s.write("fixture-data"); }, data(s, bytes) { resolve(Buffer.from(bytes).toString()); s.end(); }, error(_s, e) { reject(e); } } }).catch(reject);
      });
      expect(response).toBe("fixture-data");
      const otherTarget = await run([...base, "-W", `127.0.0.1:${targetPort + 1}`], { timeoutMs: 5000 });
      expect(otherTarget.code).not.toBe(0); expect(otherTarget.stderr).toContain("administratively prohibited");
      const command = await run([...base, "printf should-not-execute"], { timeoutMs: 5000 });
      expect(command.code).not.toBe(0); expect(command.stdout).not.toContain("should-not-execute");
      const reverse = await run([...base, "-N", "-o", "ExitOnForwardFailure=yes", "-R", `127.0.0.1:0:127.0.0.1:${targetPort}`], { timeoutMs: 5000 });
      expect(reverse.code).not.toBe(0); expect(reverse.timedOut).toBe(false);
    } finally { await run([...base, "-S", socket, "-O", "exit"], { timeoutMs: 5000 }); }
  } finally {
    daemon?.kill(); if (daemon) await daemon.exited;
    await new Promise<void>(r => echo.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
