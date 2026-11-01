export type UsageProvider = "claude" | "codex" | "grok" | "agy";
export interface UsagePoint { window: string; percentUsed: number; resetsAt: number | null; sampledAt: number }
export interface UsageAccountHistory {
  provider: UsageProvider;
  accountId: string;
  accountLabel: string;
  /** Opaque stable identity distinguishes replaced credentials in the same slot. */
  identityKey: string;
  archived?: boolean;
  state: "ok" | "stale" | "unavailable" | "error";
  detail: string;
  latest: UsagePoint[];
  history: UsagePoint[];
  resets: { window: string; resetsAt: number }[];
}
export interface UsageResponse { from: number; to: number; accounts: UsageAccountHistory[] }
