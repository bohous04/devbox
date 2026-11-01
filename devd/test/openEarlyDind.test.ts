import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config";
import { getSession, openDb } from "../src/db";
import { SessionManager } from "../src/sessions";
import { sh } from "./helpers/sh";

// A new session starts its dind sidecar in parallel with the checkout (openWithEarlyDind).
// Real git, fake `docker` in PATH that only logs its argv.
const savedPath = process.env.PATH;
afterEach(() => { process.env.PATH = savedPath; });

function fakeDocker(): () => string[] {
  const dir = mkdtempSync(join(tmpdir(), "fake-docker-"));
  const log = join(dir, "log");
  writeFileSync(log, "");
  writeFileSync(join(dir, "docker"), `#!/bin/sh\necho "$*" >> "${log}"\ncase "$1" in exec) echo 27.0;; esac\nexit 0\n`);
  chmodSync(join(dir, "docker"), 0o755);
  process.env.PATH = `${dir}:${savedPath}`;
  return () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "devd-early-dind-"));
  const bare = join(root, "origin.git");
  sh(root, "git", "init", "--bare", "-b", "main", bare);
  const seed = mkdtempSync(join(tmpdir(), "seed-"));
  sh(seed, "git", "init", "-b", "main"); sh(seed, "git", "config", "user.email", "t@t"); sh(seed, "git", "config", "user.name", "t");
  writeFileSync(join(seed, "f.txt"), "x\n");
  sh(seed, "git", "add", "."); sh(seed, "git", "commit", "-m", "init"); sh(seed, "git", "push", bare, "HEAD:main");
  const db = openDb(":memory:");
  const mgr = new SessionManager({ db, cfg: structuredClone(DEFAULT_CONFIG), root, image: "alpine:3", extraMounts: [], cmd: ["sleep", "infinity"], controlRoot: join(root, "ctl"), dind: true });
  return { db, mgr, bare };
}

const sessionRun = (l: string) => l.startsWith("run ") && l.includes("--name dev-acme-app ");

test("a new session: the sidecar is up before the session container runs", async () => {
  const log = fakeDocker();
  const { mgr, bare } = setup();
  const r = await mgr.open({ folder: "acme", project: "acme", repo: "app", cloneUrl: bare });
  expect(r.created).toBe(true);
  const lines = log();
  const sidecarReady = lines.findIndex((l) => l.startsWith("exec dind-dev-acme-app docker version"));
  const container = lines.findIndex(sessionRun);
  expect(sidecarReady).toBeGreaterThanOrEqual(0);
  expect(container).toBeGreaterThan(sidecarReady);
});

test("the sidecar starts before the clone finishes, and a failed open removes it again", async () => {
  const log = fakeDocker();
  const { mgr, db } = setup();
  await expect(mgr.open({ folder: "acme", project: "acme", repo: "app", cloneUrl: "/nonexistent/repo.git" })).rejects.toThrow();
  const lines = log();
  // Started although the clone failed → it ran alongside the clone, not after it.
  expect(lines.some((l) => l.startsWith("run -d") && l.includes("dind-dev-acme-app"))).toBe(true);
  expect(lines).toContain("rm -f dind-dev-acme-app");
  expect(lines).toContain("volume rm dind-dev-acme-app-data");
  expect(lines.some(sessionRun)).toBe(false);
  expect(getSession(db, "dev-acme-app")).toBeNull();
});

test("opening an explicit, unknown session id never touches dind", async () => {
  const log = fakeDocker();
  const { mgr } = setup();
  await expect(mgr.open({ folder: "acme", project: "acme", repo: "app", sessionId: "dev-acme-app-9" })).rejects.toThrow(/Unknown session/);
  expect(log()).toEqual([]);
});
