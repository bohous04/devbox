import type { Database } from "bun:sqlite";
import { getInstaboxBase, setInstaboxBase } from "../db";
import { ibxAlias } from "../dockerTarget";
import { run, timeoutFor } from "../proc";
import { MAX_EXEC_TIMEOUT_MS, type InstaboxClient } from "./client";
import type { InstaboxSsh } from "./ssh";
import { shq } from "./transfer";

export const BASE_TEMPLATE = "agent-browser";
// Spike: docker is preinstalled in agent-browser, exec/ssh run as `user` (uid 1000,
// groups docker+sudo) and `sudo -n` works without a password. /data is owned by root.
export const BASE_TOOLS_CMD = [
  "docker version --format '{{.Server.Version}}' >/dev/null",
  "(command -v tailscale >/dev/null || sudo -n sh -c 'curl -fsSL https://tailscale.com/install.sh | sh')",
  "(command -v mosh >/dev/null || (sudo -n apt-get update -qq && sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq mosh))",
  "sudo -n mkdir -p /data/devbox && sudo -n chown 1000:1000 /data/devbox",
].join(" && ");

const LOAD_TIMEOUT_MS = 30 * 60_000;
const SNAPSHOT_TIMEOUT_MS = 30 * 60_000;

export async function localImageDigest(image: string): Promise<string | null> {
  const r = await run(["docker", "image", "inspect", "-f", "{{.Id}}", image], { timeoutMs: timeoutFor("DOCKER_QUERY") });
  return r.code === 0 ? r.stdout.trim() || null : null;
}

export type BaseStep = "digest" | "machine" | "tools" | "image" | "snapshot" | "cleanup" | "done";
export interface BaseJob { id: string; status: "running" | "done" | "error"; step: BaseStep; error?: string; startedAt: number }
export interface BaseOps { digest(): Promise<string | null>; loadImage(remote: string[]): Promise<void> }
export interface BaseBuilderDeps {
  db: Database; client: InstaboxClient; ssh: Pick<InstaboxSsh, "ensure" | "forget">; image: string;
  ops?: Partial<BaseOps>; now?: () => number;
}

export class BaseBuilder {
  private jobs = new Map<string, BaseJob>();
  private running: BaseJob | null = null;
  private ops: BaseOps;

  constructor(private d: BaseBuilderDeps) {
    this.ops = {
      digest: () => localImageDigest(d.image),
      loadImage: async (remote) => {
        const r = await run(["bash", "-c", `set -o pipefail; docker save ${shq(d.image)} | ${remote.map(shq).join(" ")} load`], { timeoutMs: LOAD_TIMEOUT_MS });
        if (r.timedOut || r.code !== 0) throw new Error(`docker load on the machine failed: ${r.timedOut ? "timeout" : r.stderr.trim().slice(0, 300)}`);
      },
      ...d.ops,
    };
  }

  job(id: string): BaseJob | null { return this.jobs.get(id) ?? null; }
  /** Is a build running? reconcile uses this to tell that a devbox=base-build machine is not a leftover. */
  isRunning(): boolean { return this.running !== null; }

  /** null = a build is already running (two concurrent ones would overwrite each other's instabox_base). */
  start(): BaseJob | null {
    if (this.running) return null;
    const job: BaseJob = { id: crypto.randomUUID(), status: "running", step: "digest", startedAt: this.d.now?.() ?? Date.now() };
    this.jobs.set(job.id, job);
    this.running = job;
    void this.build(job).finally(() => { this.running = null; });
    return job;
  }

  private async build(job: BaseJob): Promise<void> {
    let m: string | null = null;
    // Snapshot created by this build, until it is recorded as the base (I5c): if the build
    // then fails, nobody would know about it and it would occupy the account's storage.
    let orphanSnapshot: string | null = null;
    const step = (s: BaseStep) => { job.step = s; };
    try {
      step("digest");
      const digest = await this.ops.digest();
      if (!digest) throw new Error(`local image ${this.d.image} not found — build it first`);
      step("machine");
      m = (await this.d.client.create(BASE_TEMPLATE, { name: "devbox-base-build", metadata: { devbox: "base-build" } })).id;
      step("tools");
      const tools = await this.d.client.run(m, BASE_TOOLS_CMD, { timeoutMs: MAX_EXEC_TIMEOUT_MS });
      if (tools.exitCode !== 0) throw new Error(`installing tools failed: ${(tools.stderr || tools.stdout).trim().slice(0, 300)}`);
      step("image");
      await this.d.ssh.ensure(m);
      await this.ops.loadImage(["docker", "-H", `ssh://${ibxAlias(m)}`]);
      step("snapshot");
      const name = `devbox-base-${digest.replace(/^sha256:/, "").slice(0, 12)}`;
      const sn = await this.d.client.snapshot(m, name);
      orphanSnapshot = sn.id;
      await this.d.client.waitSnapshotReady(sn.id, SNAPSHOT_TIMEOUT_MS);
      step("cleanup");
      await this.d.client.kill(m);
      this.d.ssh.forget(m);
      m = null;
      const old = getInstaboxBase(this.d.db);
      setInstaboxBase(this.d.db, { snapshot_id: sn.id, image_digest: digest, built_at: this.d.now?.() ?? Date.now() });
      orphanSnapshot = null;
      if (old && old.snapshot_id !== sn.id) await this.d.client.deleteSnapshot(old.snapshot_id).catch((e) => console.error("deleting the old base snapshot:", (e as Error).message));
      step("done");
      job.status = "done";
    } catch (e) {
      job.status = "error";
      job.error = (e as Error).message;
      if (m) { await this.d.client.kill(m).catch(() => false); this.d.ssh.forget(m); }
      if (orphanSnapshot) {
        const sn = orphanSnapshot;
        await this.d.client.deleteSnapshot(sn).catch((d) => { console.error(`base build: deleting the unused snapshot ${sn} failed:`, (d as Error).message); return false; });
      }
    }
  }
}
