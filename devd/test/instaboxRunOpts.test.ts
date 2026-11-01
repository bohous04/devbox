import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config";
import { openDb } from "../src/db";
import type { RunOpts } from "../src/docker";
import { IBX_PATHS, toRemoteRunOpts } from "../src/instabox/runOpts";
import { SessionManager } from "../src/sessions";

const ctl = "/var/lib/devd/sessions/dev-p-r";
const projects = "/srv/dev/_claude-projects/dev-p-r";
const base: RunOpts = {
  name: "dev-p-r", image: "devbox:latest", workspace: IBX_PATHS.ws("dev-p-r"), portBase: 40100, portsPerSession: 10, bindIp: "10.0.0.1",
  extraMounts: [
    "/var/run/docker.sock:/var/run/docker.sock", "/srv/prod-db/catalog.json:/srv/prod-db/catalog.json:ro",
    "claude-home:/home/dev/.claude", "codex-home:/home/dev/.codex", "grok-home:/home/dev/.grok", "/etc/devd/mac-mcp:/opt/mac-mcp:ro",
    `${ctl}:/run/devd`, "/srv/dev/_inbox:/inbox:ro", `${projects}:/home/dev/.claude/projects/-workspace`,
    "/root/.config/gh:/home/dev/.config/gh:ro", `${ctl}/gitea-tokens.json:/run/devbox-git/gitea-tokens.json:ro`,
    "/tmp/prod-keys-x/k:/home/dev/.ssh/prod_k:ro", "claude-acct-a1:/home/dev/.claude-accounts/a1", "codex-acct-g1:/home/dev/.codex-accounts/g1",
  ],
  env: { DEVD_SESSION_ID: "dev-p-r", DEVD_URL: "http://100.1.1.1:4300", DEVD_AGENT: "claude" },
};
const o = { id: "dev-p-r", controlDir: ctl, claudeProjectsDir: projects, ghConfigDir: "/root/.config/gh" };

test("toRemoteRunOpts remaps paths, drops host-only mounts and adds desktop", () => {
  const r = toRemoteRunOpts(base, o);
  expect(r.workspace).toBe("/data/devbox/ws/dev-p-r");
  expect(r.bindIp).toBe("127.0.0.1");
  expect(r.network).toBeUndefined();
  expect(r.extraMounts).toEqual([
    "/var/run/docker.sock:/var/run/docker.sock",
    "claude-home:/home/dev/.claude", "codex-home:/home/dev/.codex", "grok-home:/home/dev/.grok",
    "/data/devbox/ctl/dev-p-r:/run/devd",
    "/data/devbox/claude-projects/dev-p-r:/home/dev/.claude/projects/-workspace",
    "/data/devbox/secrets/gh:/home/dev/.config/gh:ro",
    "/data/devbox/ctl/dev-p-r/gitea-tokens.json:/run/devbox-git/gitea-tokens.json:ro",
    "claude-acct-a1:/home/dev/.claude-accounts/a1", "codex-acct-g1:/home/dev/.codex-accounts/g1",
    "/tmp/.X11-unix:/tmp/.X11-unix",
  ]);
  expect(r.env!.DISPLAY).toBe(":1");
  expect(r.env!.DEVBOX_HEADED).toBe("1");
  expect(r.env!.DEVD_AGENT).toBe("claude");
});

test("toRemoteRunOpts: dind is not carried over, the VM socket is added, real gitea tokens are not", () => {
  const r = toRemoteRunOpts({
    ...base, network: "dind-net-dev-p-r",
    extraMounts: ["claude-home:/home/dev/.claude", "/etc/devd/gitea-tokens.json:/run/devbox-git/gitea-tokens.json:ro"],
    env: { DOCKER_HOST: "tcp://dind-dev-p-r:2375", DEVD_AGENT: "codex" },
  }, o);
  expect(r.network).toBeUndefined();
  expect(r.env!.DOCKER_HOST).toBeUndefined();
  expect(r.extraMounts).toEqual(["/var/run/docker.sock:/var/run/docker.sock", "claude-home:/home/dev/.claude", "/tmp/.X11-unix:/tmp/.X11-unix"]);
});

test("storage guard flag: set for local sessions on a guarded host, never carried to a VM", async () => {
  const mk = (guarded: boolean) => new SessionManager({
    db: openDb(":memory:"), cfg: structuredClone(DEFAULT_CONFIG), root: mkdtempSync(join(tmpdir(), "sg-")), image: "devbox:latest",
    controlRoot: mkdtempSync(join(tmpdir(), "sg-ctl-")), extraMounts: [], storageGuard: () => guarded,
  });
  // runOpts is private; element access keeps the test type-checked against its real signature.
  const local = (m: SessionManager) => m["runOpts"]("dev-p-r", "/srv/dev/p/r", 40100, "p", "r", "claude");
  expect((await local(mk(true))).env!.DEVBOX_STORAGE_GUARD).toBe("1");
  expect((await local(mk(false))).env!.DEVBOX_STORAGE_GUARD).toBeUndefined();
  const remote = await mk(true).remoteRunOpts("dev-p-r", 40100, "p", "r", "claude", "http://100.1.1.1:4300");
  expect(remote.env!.DEVBOX_STORAGE_GUARD).toBeUndefined();
});

test("SessionManager.remoteRunOpts: no dind, DEVD_URL and the gitea stub on the tailscale address", async () => {
  const root = mkdtempSync(join(tmpdir(), "ibx-ro-"));
  const controlRoot = join(root, "_ctl");
  const mgr = new SessionManager({
    db: openDb(":memory:"), cfg: structuredClone(DEFAULT_CONFIG), root, image: "devbox:latest", controlRoot, dind: true,
    extraMounts: ["claude-home:/home/dev/.claude"],
    issuePlaceholder: () => "ph-1", giteaInstances: () => [{ name: "infra", url: "https://git.example.com" }],
  });
  const r = await mgr.remoteRunOpts("dev-p-r", 40100, "p", "r", "claude", "http://100.1.1.1:4300");
  expect(r.workspace).toBe("/data/devbox/ws/dev-p-r");
  expect(r.network).toBeUndefined();
  expect(r.env!.DOCKER_HOST).toBeUndefined();
  expect(r.env!.DEVD_URL).toBe("http://100.1.1.1:4300");
  // The clipboard guard and hooks in the container identify themselves via DEVD_SESSION_ID.
  expect(r.env!.DEVD_SESSION_ID).toBe("dev-p-r");
  expect(r.env!.OTEL_EXPORTER_OTLP_ENDPOINT).toBe("http://100.1.1.1:4300");
  expect(r.env!.DEVD_GIT_INSTEADOF).toBe("infra=https://git.example.com");
  expect(r.extraMounts).toContain("/data/devbox/ctl/dev-p-r/gitea-tokens.json:/run/devbox-git/gitea-tokens.json:ro");
  expect(r.extraMounts).not.toContain(`${root}/_inbox:/inbox:ro`);
  expect(JSON.parse(readFileSync(join(controlRoot, "dev-p-r", "gitea-tokens.json"), "utf8"))).toEqual({ "100.1.1.1:4300": "ph-1" });
});
