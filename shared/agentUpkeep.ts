export type UpkeepProvider = "claude" | "codex" | "grok" | "agy";
export interface AgentUpkeepSession {
  id: string; project: string; repo: string; version: string | null;
  running: number | null; restartRequired: boolean | null;
}
export interface AgentUpkeepStatus {
  provider: UpkeepProvider; latest: string | null; image: string | null;
  mode: "nightly" | "on-launch";
  sessions: AgentUpkeepSession[];
}
export interface AgentUpkeepResult {
  provider: UpkeepProvider; updated: string[]; restarted: string[];
  deferred: string[]; failed: string[]; unchanged: string[];
  built: boolean; error?: string;
}
