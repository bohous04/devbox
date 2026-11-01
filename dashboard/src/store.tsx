import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { api, type DevdConfig, type DiskStats, type LiveStats, type ProjectStat, type Totals } from "./api";

export interface Store {
  pendingWrites: number | null;
  live: LiveStats | null;
  totals: Totals | null;
  projects: ProjectStat[];
  disk: DiskStats | null;
  config: DevdConfig | null;
  version: string | null;
  connected: boolean;
  attempted: boolean;
  lastUpdated: number | null;
  refresh: () => Promise<void>;
}

const Ctx = createContext<Store | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [pendingWrites, setPendingWrites] = useState<number | null>(null);
  const [live, setLive] = useState<LiveStats | null>(null);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [projects, setProjects] = useState<ProjectStat[]>([]);
  const [disk, setDisk] = useState<DiskStats | null>(null);
  const [config, setConfig] = useState<DevdConfig | null>(null);
  const [version, setVersion] = useState<string | null>(null);
  const [connected, setConnected] = useState(true);
  const [attempted, setAttempted] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const [l, t, p, d, w] = await Promise.allSettled([api.live(), api.totals(), api.projects(), api.disk(), api.prodWriteCount()]);
      if (w.status === "fulfilled") setPendingWrites(w.value.count);
      if (l.status === "fulfilled") setLive(l.value);
      if (t.status === "fulfilled") setTotals(t.value);
      if (p.status === "fulfilled") setProjects(p.value);
      if (d.status === "fulfilled") setDisk(d.value);
      const ok = l.status === "fulfilled";
      setConnected(ok);
      setAttempted(true);
      if (ok) setLastUpdated(Date.now());
    } finally {
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    refresh();
    api.health().then((h) => setVersion(h.version ?? null)).catch(() => {});
    api.config().then(setConfig).catch(() => {});
    const h = setInterval(refresh, 5000);
    return () => clearInterval(h);
  }, [refresh]);

  return (
    <Ctx.Provider value={{ pendingWrites, live, totals, projects, disk, config, version, connected, attempted, lastUpdated, refresh }}>
      {children}
    </Ctx.Provider>
  );
}

export function useStore(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error("useStore outside StoreProvider");
  return s;
}

/** Ticking clock for relative labels ("3 s ago", uptime). */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const h = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(h);
  }, [intervalMs]);
  return now;
}
