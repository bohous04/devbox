import { accountMountList, CLAUDE_VOLUME } from "../accountProfiles";
import { CODEX_VOLUME } from "../agentAuth";
import { codexAccountMountList } from "../codexAccountProfiles";
import { readVolumeFile, writeVolumeFile, type PoolAccountIds } from "./transfer";

export interface CredFile { kind: "claude" | "codex"; volume: string; file: string }
export const SHARED_CRED_VOLUMES: ReadonlySet<string> = new Set([CLAUDE_VOLUME, CODEX_VOLUME]);

// Login files live in the ROOT of the volume: claude profile see provisionScript
// (`/profile/.credentials.json`), codex profile see AUTH_PATH (the volume is mounted at ~/.codex).
export function credentialFiles(ids: PoolAccountIds): CredFile[] {
  const volume = (m: string) => m.slice(0, m.indexOf(":"));
  return [
    { kind: "claude", volume: CLAUDE_VOLUME, file: ".credentials.json" },
    { kind: "codex", volume: CODEX_VOLUME, file: "auth.json" },
    ...accountMountList(ids.claude).map((m) => ({ kind: "claude" as const, volume: volume(m), file: ".credentials.json" })),
    ...codexAccountMountList(ids.codex).map((m) => ({ kind: "codex" as const, volume: volume(m), file: "auth.json" })),
  ];
}

// Measure of a file's "freshness" with OAuth tokens. Refresh tokens rotate: when one
// side refreshes, the other holds an invalidated token → after sync both must have
// the newer one. null = unknown (missing / broken JSON) → such a side is never propagated.
export function credFreshness(kind: "claude" | "codex", text: string | null): number | null {
  if (!text) return null;
  try {
    const j = JSON.parse(text);
    if (kind === "claude") { const v = j?.claudeAiOauth?.expiresAt; return typeof v === "number" ? v : null; }
    const t = Date.parse(j?.last_refresh ?? "");
    return Number.isFinite(t) ? t : null;
  } catch { return null; }
}

export function decideSync(local: number | null, remote: number | null): "push" | "pull" | "none" {
  if (local === null && remote === null) return "none";
  if (remote === null || (local !== null && local > remote)) return "push";
  if (local === null || remote > local) return "pull";
  return "none";
}

export interface CredIo {
  read(side: "local" | "remote", volume: string, file: string): Promise<string | null>;
  write(side: "local" | "remote", volume: string, file: string, content: string): Promise<void>;
}

export interface CredSyncResult { file: string; volume: string; action: "push" | "pull" | "none"; local: number | null; remote: number | null; error?: string }

// Each file is synced independently: one failed/timed-out account (volumeCredIo
// throws on timeout/non-zero exit code, see transfer.ts) must not bring down the rest of the loop.
export async function syncCreds(io: CredIo, files: CredFile[], mode: "both" | "push"): Promise<CredSyncResult[]> {
  const out: CredSyncResult[] = [];
  for (const f of files) {
    const file = `${f.volume}/${f.file}`;
    try {
      const [l, r] = await Promise.all([io.read("local", f.volume, f.file), io.read("remote", f.volume, f.file)]);
      const local = credFreshness(f.kind, l);
      const remote = credFreshness(f.kind, r);
      let action = decideSync(local, remote);
      if (mode === "push" && action === "pull") action = "none";
      if (action === "push") await io.write("remote", f.volume, f.file, l!);
      if (action === "pull") await io.write("local", f.volume, f.file, r!);
      out.push({ file, volume: f.volume, action, local, remote });
    } catch (e) {
      out.push({ file, volume: f.volume, action: "none", local: null, remote: null, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}

export function volumeCredIo(image: string, remotePrefix: string[]): CredIo {
  const prefix = (side: "local" | "remote") => (side === "local" ? ["docker"] : remotePrefix);
  return {
    read: (side, volume, file) => readVolumeFile(prefix(side), image, volume, file),
    write: (side, volume, file, content) => writeVolumeFile(prefix(side), image, volume, file, content),
  };
}
