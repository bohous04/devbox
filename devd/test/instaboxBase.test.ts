import { expect, test } from "bun:test";
import { getInstaboxBase, openDb, setInstaboxBase } from "../src/db";
import { BASE_TOOLS_CMD, BaseBuilder } from "../src/instabox/base";
import { FakeInstaboxClient } from "./helpers/instaboxFake";

const ssh = { ensure: async (m: string) => `ibx-${m}`, forget: () => {} };
const wait = async (b: BaseBuilder, id: string) => { for (let i = 0; i < 200 && b.job(id)!.status === "running"; i++) await Bun.sleep(5); return b.job(id)!; };

test("BASE_TOOLS_CMD: docker is only verified, root things via sudo -n, Tailscale installer", () => {
  expect(BASE_TOOLS_CMD.startsWith("docker version")).toBe(true);
  expect(BASE_TOOLS_CMD).toContain("sudo -n sh -c 'curl -fsSL https://tailscale.com/install.sh | sh'");
  expect(BASE_TOOLS_CMD).toContain("sudo -n chown 1000:1000 /data/devbox");
  expect(BASE_TOOLS_CMD).not.toContain("get.docker.com");
});

test("build: new snapshot, old one deleted, build machine killed", async () => {
  const db = openDb(":memory:");
  setInstaboxBase(db, { snapshot_id: "sn_old", image_digest: "sha256:old", built_at: 1 });
  const client = new FakeInstaboxClient();
  const loaded: string[][] = [];
  const b = new BaseBuilder({ db, client, ssh, image: "devbox:latest", ops: { digest: async () => "sha256:abcdef0123456789abcd", loadImage: async (r) => { loaded.push(r); } } });
  const job = b.start()!;
  expect(b.start()).toBeNull(); // a second concurrent build is rejected
  expect((await wait(b, job.id)).status).toBe("done");
  expect(client.calls).toContain("create agent-browser");
  expect(loaded).toEqual([["docker", "-H", "ssh://ibx-m_1"]]);
  expect(getInstaboxBase(db)).toMatchObject({ snapshot_id: "sn_devbox-base-abcdef012345", image_digest: "sha256:abcdef0123456789abcd" });
  expect(client.calls).toContain("deleteSnapshot sn_old");
  expect(client.machines.size).toBe(0);
  expect(b.start()).not.toBeNull(); // once finished it can be started again
});

test("build fails at load image → old base stays, machine killed", async () => {
  const db = openDb(":memory:");
  setInstaboxBase(db, { snapshot_id: "sn_old", image_digest: "sha256:old", built_at: 1 });
  const client = new FakeInstaboxClient();
  const b = new BaseBuilder({ db, client, ssh, image: "devbox:latest", ops: { digest: async () => "sha256:x", loadImage: async () => { throw new Error("broken pipe"); } } });
  const done = await wait(b, b.start()!.id);
  expect(done).toMatchObject({ status: "error", step: "image" });
  expect(done.error).toContain("broken pipe");
  expect(getInstaboxBase(db)!.snapshot_id).toBe("sn_old");
  expect(client.machines.size).toBe(0);
});

test("I5c: snapshot created, build then fails (waitSnapshotReady timeout) → snapshot is deleted, base stays", async () => {
  const db = openDb(":memory:");
  setInstaboxBase(db, { snapshot_id: "sn_old", image_digest: "sha256:old", built_at: 1 });
  const client = new FakeInstaboxClient();
  client.failNext.set("waitSnapshotReady", new Error("snapshot was not ready within 1800 s"));
  const b = new BaseBuilder({ db, client, ssh, image: "devbox:latest", ops: { digest: async () => "sha256:abcdef0123456789abcd", loadImage: async () => {} } });
  const done = await wait(b, b.start()!.id);
  expect(done).toMatchObject({ status: "error", step: "snapshot" });
  expect(client.calls).toContain("deleteSnapshot sn_devbox-base-abcdef012345");
  expect(client.calls).not.toContain("deleteSnapshot sn_old");
  expect(getInstaboxBase(db)!.snapshot_id).toBe("sn_old");
  expect(client.machines.size).toBe(0);
});

test("I5c: cleanup kill throws → the unrecorded snapshot is deleted; a delete error is only logged", async () => {
  const db = openDb(":memory:");
  const client = new FakeInstaboxClient();
  client.failNext.set("kill", new Error("api down"));
  client.failNext.set("deleteSnapshot", new Error("still in use"));
  const b = new BaseBuilder({ db, client, ssh, image: "devbox:latest", ops: { digest: async () => "sha256:abcdef0123456789abcd", loadImage: async () => {} } });
  const errs: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { errs.push(a.map(String).join(" ")); };
  let done;
  try { done = await wait(b, b.start()!.id); } finally { console.error = orig; }
  expect(done).toMatchObject({ status: "error", step: "cleanup" });
  expect(client.calls).toContain("deleteSnapshot sn_devbox-base-abcdef012345");
  expect(errs.some((e) => e.includes("sn_devbox-base-abcdef012345") && e.includes("still in use"))).toBe(true);
  expect(getInstaboxBase(db)).toBeNull();
});

test("I5c: a recorded snapshot is not deleted on a later error (deleting the old one); isRunning during the build", async () => {
  const db = openDb(":memory:");
  setInstaboxBase(db, { snapshot_id: "sn_old", image_digest: "sha256:old", built_at: 1 });
  const client = new FakeInstaboxClient();
  client.failNext.set("deleteSnapshot", new Error("gone"));
  const b = new BaseBuilder({ db, client, ssh, image: "devbox:latest", ops: { digest: async () => "sha256:abcdef0123456789abcd", loadImage: async () => {} } });
  expect(b.isRunning()).toBe(false);
  const job = b.start()!;
  expect(b.isRunning()).toBe(true);
  const orig = console.error;
  console.error = () => {};
  try { expect((await wait(b, job.id)).status).toBe("done"); } finally { console.error = orig; }
  await Bun.sleep(1);
  expect(b.isRunning()).toBe(false);
  expect(client.calls.filter((c) => c.startsWith("deleteSnapshot"))).toEqual(["deleteSnapshot sn_old"]);
  expect(getInstaboxBase(db)!.snapshot_id).toBe("sn_devbox-base-abcdef012345");
});

test("tools step sends an exec timeout within the InstaBox API range (≤ 600 000 ms)", async () => {
  const db = openDb(":memory:");
  const client = new FakeInstaboxClient();
  const seen: (number | undefined)[] = [];
  const origRun = client.run.bind(client);
  client.run = async (id: string, cmd: string, o?: { timeoutMs?: number }) => { seen.push(o?.timeoutMs); return origRun(id, cmd); };
  const b = new BaseBuilder({ db, client, ssh: { ensure: async (m: string) => `ibx-${m}`, forget: () => {} }, image: "devbox:latest", ops: { digest: async () => "sha256:abcdef0123456789abcd", loadImage: async () => {} } });
  const job = b.start()!;
  for (let i = 0; i < 100 && b.job(job.id)!.status === "running"; i++) await Bun.sleep(5);
  expect(b.job(job.id)!.status).toBe("done");
  expect(seen.length).toBeGreaterThan(0);
  for (const t of seen) expect(t === undefined || (t > 0 && t <= 600_000)).toBe(true);
});
