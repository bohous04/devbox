import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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

// An ended session leaves a read-only transcript (endedSessions.ts): the last mirror read runs while the container is
// still there, the store and the images move into the archive, and the inbox hears of it.
test("end() keeps the thread and its images as an ended transcript and announces it", async () => {
  const bin = mkdtempSync(join(tmpdir(), "fake-docker-"));
  writeFileSync(join(bin, "docker"), "#!/usr/bin/env bash\necho \"$@\" >> \"$(dirname \"$0\")/calls\"\nexit 0\n");
  chmodSync(join(bin, "docker"), 0o755);
  const orig = process.env.PATH;
  process.env.PATH = `${bin}:${orig}`;
  try {
    const db = openDb(":memory:");
    const root = mkdtempSync(join(tmpdir(), "end-transcript-"));
    const img = "00000000-0000-4000-8000-000000000000.png";
    mkdirSync(join(root, "_inbox", "dev-a-b"), { recursive: true });
    writeFileSync(join(root, "_inbox", "dev-a-b", img), "x");
    const store = ThreadStore.open(root, "dev-a-b");
    store.apply({ seq: 1, ts: 1, event: { type: "message.final", runId: "r1", itemId: "u1", role: "user", text: "Tidy the readme" } });
    store.close();
    insertSession(db, {
      id: "dev-a-b", folder: "acme", project: "a", repo: "b", container: "dev-a-b", port_base: 41500,
      status: "running", solo: 0, created_at: 0, last_active_at: 0, important: 0, runtime: "chat",
    });
    const order: string[] = [];
    const ended: EndedSession[] = [];
    const mgr: SessionManager = new SessionManager({
      db, cfg: DEFAULT_CONFIG, root, image: "unused", extraMounts: [], cmd: [], controlRoot: join(root, "ctl"),
      now: () => Date.parse("2026-11-20T10:15:00Z"),
      finalizeTranscript: async (s) => { order.push(`finalize ${s.id} ending=${mgr.isEnding(s.id)} rm-before=${!existsSync(join(bin, "calls"))}`); },
      onEnded: (e) => { ended.push(e); },
    });
    await mgr.end("dev-a-b");
    expect(order).toEqual(["finalize dev-a-b ending=true rm-before=true"]);
    const dir = join(root, "_chat-archive", "dev-a-b-20261120-101500");
    expect(existsSync(join(dir, "dev-a-b.sqlite"))).toBe(true);
    expect(existsSync(join(dir, "images", img))).toBe(true);
    expect(existsSync(join(root, "_inbox", "dev-a-b"))).toBe(false);
    expect(ended.map((e) => [e.id, e.topic, e.runtime])).toEqual([["dev-a-b-20261120-101500", "Tidy the readme", "chat"]]);
    expect(listEnded(db)).toEqual(ended);
    db.close();
  } finally {
    process.env.PATH = orig;
  }
});
