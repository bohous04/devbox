import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../src/sessions";
import { insertSession, openDb } from "../src/db";
import { DEFAULT_CONFIG } from "../src/config";
import { listEnded } from "../src/endedSessions";
import { ThreadStore } from "../src/threadStore";
import type { EndedSession } from "../../shared/ended";

test("ending status follows the actual end operation and clears on success or failure", async () => {
  const db = openDb(":memory:");
  const mgr = new SessionManager({ db, cfg: DEFAULT_CONFIG, root: "/tmp", image: "unused", extraMounts: [], cmd: [] });
  let finish!: () => void;
  const wait = new Promise<void>(resolve => { finish = resolve; });
  const pending = mgr.withLock(["dev-apps-web"], "end", () => wait);
  expect(mgr.isEnding("dev-apps-web")).toBe(true);
  expect(mgr.isEnding("dev-apps-other")).toBe(false);
  finish(); await pending;
  expect(mgr.isEnding("dev-apps-web")).toBe(false);
  await expect(mgr.withLock(["dev-apps-web"], "end", async () => { throw new Error("backup failed"); })).rejects.toThrow("backup failed");
  expect(mgr.isEnding("dev-apps-web")).toBe(false);
  await mgr.withLock(["dev-apps-web"], "stop", async () => { expect(mgr.isEnding("dev-apps-web")).toBe(false); });
  db.close();
});

// The chat store keeps taking the agent's events while the backup runs; it is released only right before the
// transcripts and the store are archived. isEnding keeps readers out the whole time.
test("end() releases the chat thread after the backup and container removal, still while ending", async () => {
  const bin = mkdtempSync(join(tmpdir(), "fake-docker-"));
  writeFileSync(join(bin, "docker"), "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(join(bin, "docker"), 0o755);
  const orig = process.env.PATH;
  process.env.PATH = `${bin}:${orig}`;
  try {
    const db = openDb(":memory:");
    const root = mkdtempSync(join(tmpdir(), "end-order-"));
    insertSession(db, {
      id: "dev-a-b", folder: "acme", project: "a", repo: "b", container: "dev-a-b", port_base: 41500,
      status: "running", solo: 0, created_at: 0, last_active_at: 0, important: 0, runtime: "chat",
    });
    const order: string[] = [];
    const mgr: SessionManager = new SessionManager({
      db, cfg: DEFAULT_CONFIG, root, image: "unused", extraMounts: [], cmd: [], controlRoot: join(root, "ctl"),
      preserveForEnd: async () => { order.push("preserve"); },
      releaseThread: (id) => { order.push(`release ending=${mgr.isEnding(id)}`); },
    });
    await mgr.end("dev-a-b");
    expect(order).toEqual(["preserve", "release ending=true"]);
    db.close();
  } finally {
    process.env.PATH = orig;
  }
});

// S5-R23: a session's chat images go with it, but only once its container (and bridge) is gone and its thread is archived.
test("end() deletes the session's chat images after the container is gone and the thread released; the shared inbox stays", async () => {
  const bin = mkdtempSync(join(tmpdir(), "fake-docker-"));
  writeFileSync(join(bin, "docker"), "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(join(bin, "docker"), 0o755);
  const orig = process.env.PATH;
  process.env.PATH = `${bin}:${orig}`;
  try {
    const db = openDb(":memory:");
    const root = mkdtempSync(join(tmpdir(), "end-images-"));
    mkdirSync(join(root, "_inbox", "dev-a-b"), { recursive: true });
    writeFileSync(join(root, "_inbox", "dev-a-b", "00000000-0000-4000-8000-000000000000.png"), "x");
    writeFileSync(join(root, "_inbox", "shared.png"), "x");
    insertSession(db, {
      id: "dev-a-b", folder: "acme", project: "a", repo: "b", container: "dev-a-b", port_base: 41500,
      status: "running", solo: 0, created_at: 0, last_active_at: 0, important: 0, runtime: "chat",
    });
    const seen: boolean[] = [];
    const mgr = new SessionManager({
      db, cfg: DEFAULT_CONFIG, root, image: "unused", extraMounts: [], cmd: [], controlRoot: join(root, "ctl"),
      releaseThread: () => { seen.push(existsSync(join(root, "_inbox", "dev-a-b"))); },
    });
    await mgr.end("dev-a-b");
    expect(seen).toEqual([true]);
    expect(existsSync(join(root, "_inbox", "dev-a-b"))).toBe(false);
    expect(existsSync(join(root, "_inbox", "shared.png"))).toBe(true);
    db.close();
  } finally {
    process.env.PATH = orig;
  }
});

// An ended session leaves a read-only transcript (endedSessions.ts): the last mirror read runs right before the
// container goes, the store and the images move into the archive, and the inbox hears of it.
const THREAD = "0b1c2d3e-0000-4000-8000-000000000001";
const IMG = "00000000-0000-4000-8000-000000000000.png";
const AT = Date.parse("2026-11-20T10:15:00Z");

async function ending(o: { runtime?: "chat" | "tmux"; store?: boolean; truncated?: boolean; prepare?: (root: string) => void } = {}) {
  const bin = mkdtempSync(join(tmpdir(), "fake-docker-"));
  writeFileSync(join(bin, "docker"), "#!/usr/bin/env bash\necho \"$@\" >> \"$(dirname \"$0\")/calls\"\nexit 0\n");
  chmodSync(join(bin, "docker"), 0o755);
  const orig = process.env.PATH;
  process.env.PATH = `${bin}:${orig}`;
  const db = openDb(":memory:");
  const root = mkdtempSync(join(tmpdir(), "end-transcript-"));
  const runtime = o.runtime ?? "chat";
  try {
    mkdirSync(join(root, "_inbox", "dev-a-b"), { recursive: true });
    writeFileSync(join(root, "_inbox", "dev-a-b", IMG), "x");
    // The Claude conversation the container kept in its projects dir: continue resumes it from the archive.
    mkdirSync(join(root, "_claude-projects", "dev-a-b"), { recursive: true });
    writeFileSync(join(root, "_claude-projects", "dev-a-b", `${THREAD}.jsonl`), "{}\n");
    if (o.store !== false) {
      const store = ThreadStore.open(root, "dev-a-b", runtime === "tmux" ? { dir: "_mirrors" } : {});
      store.apply({ seq: 1, ts: 1, event: { type: "message.final", runId: "r1", itemId: "u1", role: "user", text: "Tidy the readme" } });
      store.close();
    }
    insertSession(db, {
      id: "dev-a-b", folder: "acme", project: "a", repo: "b", container: "dev-a-b", port_base: 41500,
      status: "running", solo: 0, created_at: 0, last_active_at: 0, important: 0, runtime,
    });
    o.prepare?.(root);
    const order: string[] = [];
    const ended: EndedSession[] = [];
    const notices: string[] = [];
    const mgr: SessionManager = new SessionManager({
      db, cfg: DEFAULT_CONFIG, root, image: "unused", extraMounts: [], cmd: [], controlRoot: join(root, "ctl"),
      now: () => AT,
      preserveForEnd: async () => { order.push("preserve"); },
      finalizeTranscript: async (s) => {
        order.push(`finalize ${s.id} ending=${mgr.isEnding(s.id)} rm-before=${!existsSync(join(bin, "calls"))}`);
        return { truncated: o.truncated ?? false };
      },
      onEnded: (e) => { ended.push(e); },
      notify: (_t, m) => { notices.push(m); },
    });
    let error: unknown = null;
    try { await mgr.end("dev-a-b"); } catch (e) { error = e; }
    return { db, root, order, ended, notices, error, dir: join(root, "_chat-archive", "dev-a-b-20261120-101500") };
  } finally {
    process.env.PATH = orig;
  }
}

test("end() keeps the thread, its images and the Claude jsonl as an ended transcript and announces it", async () => {
  const t = await ending();
  expect(t.error).toBeNull();
  // The last read comes after the backup and right before docker rm.
  expect(t.order).toEqual(["preserve", "finalize dev-a-b ending=true rm-before=true"]);
  expect(existsSync(join(t.dir, "dev-a-b.sqlite"))).toBe(true);
  expect(existsSync(join(t.dir, "images", IMG))).toBe(true);
  expect(readFileSync(join(t.dir, `${THREAD}.jsonl`), "utf8")).toBe("{}\n");
  expect(existsSync(join(t.root, "_inbox", "dev-a-b"))).toBe(false);
  expect(t.ended.map((e) => [e.id, e.topic, e.runtime, e.transcript])).toEqual([["dev-a-b-20261120-101500", "Tidy the readme", "chat", "complete"]]);
  expect(listEnded(t.db)).toEqual(t.ended);
  expect(t.notices).toEqual([]);
});

test("a tmux session's cut-short last read marks its transcript truncated", async () => {
  const t = await ending({ runtime: "tmux", truncated: true });
  expect(t.ended.map((e) => [e.runtime, e.transcript])).toEqual([["tmux", "truncated"]]);
});

test("a tmux session never mirrored is listed as ended without a transcript", async () => {
  const t = await ending({ runtime: "tmux", store: false });
  expect(t.error).toBeNull();
  expect(t.ended.map((e) => [e.id, e.transcript])).toEqual([["dev-a-b-20261120-101500", "missing"]]);
});

test("an archive that fails is said to the owner; end() still removes the session", async () => {
  // A file where the archive directory must go: the rename fails.
  const t = await ending({ prepare: (root) => writeFileSync(join(root, "_chat-archive"), "in the way") });
  expect(t.error).toBeNull();
  expect(t.notices.length).toBe(1);
  expect(t.notices[0]).toContain("could not be archived");
  expect(t.db.query("SELECT id FROM sessions").all()).toEqual([]);
});

test("a transcript that cannot be listed is said to the owner; end() still removes the session", async () => {
  // The archived store is no SQLite database: recordEnded cannot read it.
  const t = await ending({ prepare: (root) => writeFileSync(join(root, "_threads", "dev-a-b.sqlite"), "not a database") });
  expect(t.error).toBeNull();
  expect(t.ended).toEqual([]);
  expect(t.notices.length).toBe(1);
  expect(t.notices[0]).toContain("could not be listed");
  expect(t.notices[0]).toContain("dev-a-b-20261120-101500");
  expect(t.db.query("SELECT id FROM sessions").all()).toEqual([]);
});

test("keepTranscript failing to clean up the mirror does not throw end() after the container is gone", async () => {
  // The archive fails (it would have taken the mirror files), and a directory sits where a mirror file is removed.
  const t = await ending({ prepare: (root) => {
    writeFileSync(join(root, "_chat-archive"), "in the way");
    mkdirSync(join(root, "_mirrors", "dev-a-b.sqlite-shm", "x"), { recursive: true });
  } });
  expect(t.error).toBeNull();
  expect(t.db.query("SELECT id FROM sessions").all()).toEqual([]);
});
