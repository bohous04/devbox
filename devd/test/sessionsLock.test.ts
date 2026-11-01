import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config";
import { insertSession, openDb, setImportant, getSession } from "../src/db";
import { SessionBusyError, SessionManager } from "../src/sessions";

// Fake docker: `run` sleeps, `rm`/`stop`/`start` return at once, `inspect` reports running.
function fakeDocker(sleepSec: number): () => void {
  const dir = mkdtempSync(join(tmpdir(), "fake-docker-"));
  writeFileSync(join(dir, "docker"), `#!/usr/bin/env bash
case "$1" in
  run) sleep ${sleepSec}; echo cid ;;
  inspect) echo running ;;
esac
exit 0
`);
  chmodSync(join(dir, "docker"), 0o755);
  const orig = process.env.PATH;
  process.env.PATH = `${dir}:${orig}`;
  return () => { process.env.PATH = orig; };
}

function mgrWithSession(inFlight = new Set<string>()) {
  const db = openDb(":memory:");
  const root = mkdtempSync(join(tmpdir(), "devd-lock-"));
  const id = "dev-shop-app";
  insertSession(db, {
    id, folder: "acme", project: "shop", repo: "app", container: id, port_base: 41300,
    status: "running", solo: 0, created_at: 0, last_active_at: 0, important: 0,
  });
  const mgr = new SessionManager({ db, cfg: DEFAULT_CONFIG, root, image: "alpine:3", extraMounts: [], cmd: ["sleep", "infinity"], inFlight });
  return { db, mgr, id, inFlight };
}

// openSolo does not need a pre-existing session row — it creates one itself (unlike
// mgrWithSession above, which inserts one up front for recreate/stop/open).
function freshMgr(inFlight = new Set<string>()) {
  const db = openDb(":memory:");
  const root = mkdtempSync(join(tmpdir(), "devd-lock-"));
  // controlRoot must point outside the default /var/lib/devd/sessions (DEFAULT_CONTROL_ROOT)
  // — without ROOT access openSolo (syncPromptFile) fails there with EACCES, not on what
  // is being verified here.
  const mgr = new SessionManager({ db, cfg: DEFAULT_CONFIG, root, image: "alpine:3", extraMounts: [], cmd: ["sleep", "infinity"], inFlight, controlRoot: join(root, "ctl") });
  return { db, mgr };
}

test("a second recreate on the same session is rejected, so is another operation, after completion it works again", async () => {
  const restore = fakeDocker(1);
  try {
    const { mgr, id } = mgrWithSession();
    const first = mgr.recreate(id);
    await expect(mgr.recreate(id)).rejects.toBeInstanceOf(SessionBusyError);
    await expect(mgr.stop(id)).rejects.toMatchObject({ key: id, op: "recreate" });
    await first;
    await mgr.recreate(id);   // the lock was released
  } finally { restore(); }
});

test("the lock is released even after an operation error", async () => {
  const restore = fakeDocker(0);
  try {
    const { mgr } = mgrWithSession();
    await expect(mgr.recreate("neexistuje")).rejects.toThrow(/Unknown session/);
    await expect(mgr.recreate("neexistuje")).rejects.toThrow(/Unknown session/);   // ne SessionBusyError
  } finally { restore(); }
});

test("a DB-only operation (important) goes through even during recreate and the event loop is free", async () => {
  const restore = fakeDocker(1);
  try {
    const { db, mgr, id } = mgrWithSession();
    const t0 = Date.now();
    const first = mgr.recreate(id);
    setImportant(db, id, 1);
    expect(getSession(db, id)!.important).toBe(1);
    await new Promise((r) => setTimeout(r, 50));
    expect(Date.now() - t0).toBeLessThan(500);   // recreate (1 s) did not block the loop
    expect(mgr.list().length).toBe(1);
    await first;
  } finally { restore(); }
});

test("shared inFlight: a key held by an account switch rejects a lifecycle operation", async () => {
  const restore = fakeDocker(0);
  try {
    const inFlight = new Set<string>();
    const { mgr, id } = mgrWithSession(inFlight);
    inFlight.add(id);   // accountSwitch/agentSwitch holds the session
    await expect(mgr.stop(id)).rejects.toMatchObject({ key: id, op: "switch" });
  } finally { restore(); }
});

test("simultaneous open on the same repo is rejected", async () => {
  const restore = fakeDocker(0);
  try {
    const inFlight = new Set<string>();
    const { mgr } = mgrWithSession(inFlight);
    inFlight.add("open:acme/shop/app");
    await expect(mgr.open({ folder: "acme", project: "shop", repo: "app" })).rejects.toBeInstanceOf(SessionBusyError);
  } finally { restore(); }
});

// I3 (final review PR 1): openSolo has TWO locks (the repo key "claudeSolo" until
// a free `n` is found, then the id itself) and between them a synchronous `git init` +
// `ensureOwned` on disk — the only locked path with this combination, previously
// untested. The outer lock is taken SYNCHRONOUSLY (locked() adds the key to the set
// before the first await), so the second call is rejected at once, just like recreate
// above — no need to wait for the fake docker to start.
test("openSolo: a second call on the same folder/project pair is rejected, even without an existing session", async () => {
  const restore = fakeDocker(1);
  try {
    const { db, mgr } = freshMgr();
    const first = mgr.openSolo("acme", "shop");
    await expect(mgr.openSolo("acme", "shop")).rejects.toMatchObject({ key: "open:acme/shop/claudeSolo", op: "open" });
    const opened = await first;
    expect(opened.created).toBe(true);
    expect(getSession(db, opened.session.id)).not.toBeNull();
  } finally { restore(); }
});
