// `image/srv` against a fake devd (Bun.serve) — verifies that srv itself recognises whether
// the given target is an explicit `user@host`, a server alias of the key (from GET
// /api/op/ssh-keys), or an unknown word, and that devd receives EXACTLY one of
// `server`/`target` (never both at once, see global-constraints: an explicit
// user@host always wins over an alias). The script runs as a real subprocess
// (`bash image/srv …`), not as a unit test of some JS function — we want to
// catch the ssh(1) option parsing and the final `exec ssh` too.
import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SRV = join(import.meta.dir, "..", "..", "image", "srv");

interface SshServerFixture { name: string; user: string; host: string; port: number; }
interface KeyFixture { title: string; vault: string; servers: SshServerFixture[]; }

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

// Fake `ssh` on PATH: does not touch the network, just prints its arguments, one per line
// (prefix `ARG:`), so the comparison in the test does not depend on quoting/spaces.
function fakeSshBinDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "srv-bin-"));
  const bin = join(dir, "ssh");
  writeFileSync(bin, '#!/usr/bin/env bash\nfor a in "$@"; do printf \'ARG:%s\\n\' "$a"; done\n');
  chmodSync(bin, 0o755);
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A real unix socket (not just an empty file) — `srv` tests `[ -S "$SSH_AUTH_SOCK" ]`.
function fakeAgentSocket(): string {
  const dir = mkdtempSync(join(tmpdir(), "srv-sock-"));
  const path = join(dir, "agent.sock");
  const server: Server = createServer();
  server.listen(path);
  cleanups.push(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });
  return path;
}

// Fake devd: GET /api/op/ssh-keys returns the fixture, POST /api/ssh-approvals answers
// 200 right away (live grant) and remembers the request body — no polling loop on 202.
function fakeDevd(keys: KeyFixture[]) {
  const posted: Record<string, unknown>[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/api/op/ssh-keys") {
        return Response.json({ keys });
      }
      if (req.method === "POST" && url.pathname === "/api/ssh-approvals") {
        posted.push((await req.json()) as Record<string, unknown>);
        return Response.json({ agentSock: "/fake/agent.sock", expiresAt: null });
      }
      return new Response("not found", { status: 404 });
    },
  });
  cleanups.push(() => server.stop(true));
  return { url: `http://127.0.0.1:${server.port}`, posted };
}

async function runSrv(args: string[], env: Record<string, string>) {
  const p = Bun.spawn(["bash", SRV, ...args], {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { stdout, stderr, code };
}

function argv(stdout: string): string[] {
  return stdout
    .split("\n")
    .filter((l) => l.startsWith("ARG:"))
    .map((l) => l.slice("ARG:".length));
}

const SERVERS: KeyFixture[] = [
  { title: "shop", vault: "Private", servers: [
    { name: "shop-root", user: "root", host: "192.0.2.11", port: 22 },
  ] },
];

test("explicit user@host always wins over an alias — target with port from -p, ssh argv unchanged", async () => {
  const { url, posted } = fakeDevd(SERVERS);
  const binDir = fakeSshBinDir();
  const sock = fakeAgentSocket();
  const { code, stdout, stderr } = await runSrv(
    ["shop", "--why", "reason", "-o", "X", "-p", "2222", "root@1.2.3.4", "uptime"],
    { PATH: `${binDir}:${process.env.PATH}`, DEVD_URL: url, DEVD_SESSION_ID: "dev-test", SRV_AGENT_SOCK: sock },
  );
  expect(stderr).toBe("");
  expect(code).toBe(0);
  expect(posted).toHaveLength(1);
  expect(posted[0]!.target).toBe("root@1.2.3.4:2222");
  expect(posted[0]!.server).toBeUndefined();
  expect(argv(stdout)).toEqual(["-o", "X", "-p", "2222", "root@1.2.3.4", "uptime"]);
});

test("key server alias → server in the request, ssh argv replaces the target with -p <port> <user>@<host>", async () => {
  const { url, posted } = fakeDevd(SERVERS);
  const binDir = fakeSshBinDir();
  const sock = fakeAgentSocket();
  const { code, stdout, stderr } = await runSrv(
    ["shop", "--why", "reason", "shop-root"],
    { PATH: `${binDir}:${process.env.PATH}`, DEVD_URL: url, DEVD_SESSION_ID: "dev-test", SRV_AGENT_SOCK: sock },
  );
  expect(stderr).toBe("");
  expect(code).toBe(0);
  expect(posted).toHaveLength(1);
  expect(posted[0]!.server).toBe("shop-root");
  expect(posted[0]!.target).toBeUndefined();
  expect(argv(stdout)).toEqual(["-p", "22", "root@192.0.2.11"]);
});

test("alias in the middle of ssh options and with a command — replaced only at the target position, the rest stays", async () => {
  const { url, posted } = fakeDevd(SERVERS);
  const binDir = fakeSshBinDir();
  const sock = fakeAgentSocket();
  const { code, stdout } = await runSrv(
    ["shop", "--why", "reason", "-o", "StrictHostKeyChecking=no", "shop-root", "uptime", "-a"],
    { PATH: `${binDir}:${process.env.PATH}`, DEVD_URL: url, DEVD_SESSION_ID: "dev-test", SRV_AGENT_SOCK: sock },
  );
  expect(code).toBe(0);
  expect(posted).toHaveLength(1);
  expect(posted[0]!.server).toBe("shop-root");
  expect(argv(stdout)).toEqual(["-o", "StrictHostKeyChecking=no", "-p", "22", "root@192.0.2.11", "uptime", "-a"]);
});

test("unknown word without '@' and no alias match → target unchanged", async () => {
  const { url, posted } = fakeDevd(SERVERS);
  const binDir = fakeSshBinDir();
  const sock = fakeAgentSocket();
  const { code, stderr } = await runSrv(
    ["shop", "--why", "reason", "foo"],
    { PATH: `${binDir}:${process.env.PATH}`, DEVD_URL: url, DEVD_SESSION_ID: "dev-test", SRV_AGENT_SOCK: sock },
  );
  expect(stderr).toBe("");
  expect(code).toBe(0);
  expect(posted).toHaveLength(1);
  expect(posted[0]!.target).toBe("foo");
  expect(posted[0]!.server).toBeUndefined();
});

test("no arguments: the listing contains the key servers as '<name>  <user>@<host>:<port>'", async () => {
  const { url } = fakeDevd(SERVERS);
  const { code, stdout } = await runSrv([], { DEVD_URL: url, DEVD_SESSION_ID: "dev-test" });
  expect(code).toBe(0);
  expect(stdout).toContain("shop-root  root@192.0.2.11:22");
});

async function postedTarget(args: string[]) {
  const { url, posted } = fakeDevd(SERVERS);
  const binDir = fakeSshBinDir();
  const sock = fakeAgentSocket();
  const { code, stdout, stderr } = await runSrv(
    ["shop", "--why", "reason", ...args],
    { PATH: `${binDir}:${process.env.PATH}`, DEVD_URL: url, DEVD_SESSION_ID: "dev-test", SRV_AGENT_SOCK: sock },
  );
  expect(stderr).toBe("");
  expect(code).toBe(0);
  expect(posted).toHaveLength(1);
  return { body: posted[0]!, argv: argv(stdout) };
}

test("glued -p2222 is taken as the port, ssh argv unchanged", async () => {
  const { body, argv: a } = await postedTarget(["-p2222", "root@1.2.3.4"]);
  expect(body.target).toBe("root@1.2.3.4:2222");
  expect(a).toEqual(["-p2222", "root@1.2.3.4"]);
});

test("-p AFTER the target is still used as the target port in the request", async () => {
  const { body, argv: a } = await postedTarget(["root@1.2.3.4", "-p", "2222", "uptime"]);
  expect(body.target).toBe("root@1.2.3.4:2222");
  expect(a).toEqual(["root@1.2.3.4", "-p", "2222", "uptime"]);
});

test("-p in the command (after the first command word) is not treated as a port", async () => {
  const { body } = await postedTarget(["root@1.2.3.4", "ls", "-p", "9"]);
  expect(body.target).toBe("root@1.2.3.4");
});

test("-l user and glued -luser with a host without '@' → target user@host[:port]", async () => {
  expect((await postedTarget(["-l", "deploy", "foo"])).body.target).toBe("deploy@foo");
  expect((await postedTarget(["-ldeploy", "-p2222", "foo"])).body.target).toBe("deploy@foo:2222");
  expect((await postedTarget(["foo", "-ldeploy"])).body.target).toBe("deploy@foo");
});

test("explicit user@host wins over -l", async () => {
  expect((await postedTarget(["-l", "deploy", "root@1.2.3.4"])).body.target).toBe("root@1.2.3.4");
});
