import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, type InstaboxSettings } from "../../src/config";
import { listSessions, openDb, setInstaboxBase } from "../../src/db";
import { setRemoteDocker } from "../../src/dockerTarget";
import { InstaboxSessions, type IbxOps } from "../../src/instabox/sessions";
import type { PoolAccountIds } from "../../src/instabox/transfer";
import { SessionManager, type SessionDeps } from "../../src/sessions";
import { FakeInstaboxClient } from "./instaboxFake";

export const IBX_SETTINGS: InstaboxSettings = { devdUrl: "http://100.1.1.1:4300", vmPort: 4301, suggestRamPct: 80, suggestLoadPerCore: 1, desktopWidth: 1440, desktopHeight: 900 };

export function ibxSetup(o: { ops?: Partial<IbxOps>; accountIds?: PoolAccountIds; tsKey?: string | null; mgr?: Partial<SessionDeps>; ghConfigDir?: string; notify?: (title: string, message: string) => void; revokePlaceholder?: (session: string) => void } = {}) {
  const db = openDb(":memory:");
  const root = mkdtempSync(join(tmpdir(), "ibx-root-"));
  const controlRoot = join(root, "_ctl");
  const cfg = structuredClone(DEFAULT_CONFIG);
  setInstaboxBase(db, { snapshot_id: "sn_base", image_digest: "sha256:a", built_at: 1 });
  const client = new FakeInstaboxClient();
  const opsCalls: string[] = [];
  const containers: { name: string; workspace: string; mounts: string[]; env: Record<string, string> }[] = [];
  const accountIds = { claude: [] as string[], codex: [] as string[], ...o.accountIds };
  const ops: IbxOps = {
    runContainer: async (r) => { opsCalls.push(`run ${r.name} ${r.workspace}`); containers.push({ name: r.name, workspace: r.workspace, mounts: r.extraMounts ?? [], env: r.env ?? {} }); },
    removeContainer: async (n) => { opsCalls.push(`rm ${n}`); },
    copyVolume: async (v) => { opsCalls.push(`copy ${v}`); },
    syncCreds: async (_r, files, mode) => { opsCalls.push(`creds ${mode} ${files.map((f) => f.volume).join(",")}`); return []; },
    remoteDocker: async (_r, args) => { opsCalls.push(`docker ${args.slice(0, 2).join(" ")}`); return { code: 0, stderr: "" }; },
    ...o.ops,
  };
  const mgr = new SessionManager({ db, cfg, root, image: "devbox:latest", controlRoot, ghConfigDir: o.ghConfigDir, ...o.mgr });
  const ibx = new InstaboxSessions({
    db, cfg, root, controlRoot, client, ssh: { ensure: async (m: string) => `ibx-${m}`, forget: () => {} },
    settings: IBX_SETTINGS, tailscaleAuthKey: () => (o.tsKey === undefined ? "tskey-test" : o.tsKey),
    image: "devbox:latest", mgr, accountIds: () => accountIds, ops, ghConfigDir: o.ghConfigDir, notify: o.notify, revokePlaceholder: o.revokePlaceholder,
  });
  mgr.attachInstabox(ibx);
  const cleanup = () => { for (const s of listSessions(db)) setRemoteDocker(s.container, null); };
  return { db, root, controlRoot, client, ibx, mgr, opsCalls, containers, accountIds, cleanup };
}

export async function waitJob(ibx: InstaboxSessions, id: string) {
  for (let i = 0; i < 200 && ibx.job(id)!.status === "running"; i++) await Bun.sleep(5);
  await Bun.sleep(1); // the [id] lock is released only after runCreate returns
  return ibx.job(id)!;
}

export const T = { folder: "f", project: "p", repo: "r", cloneUrl: "https://github.com/x/r.git" };
