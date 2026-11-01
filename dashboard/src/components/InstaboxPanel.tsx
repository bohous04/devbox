import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ConfirmButton, Section } from "./primitives";
import { bytes } from "../format";
import { capacityLabel, jobErrorText, JOB_STEP_LABEL, type IbxStatusDto } from "../instaboxView";

// Account occupancy, base snapshot state, orphaned machines and lost sessions. Read-only
// and manual actions — devd deletes nothing by itself (spec §2, reconciliation).
export function InstaboxPanel() {
  const [st, setSt] = useState<IbxStatusDto | null>(null);
  const [rebuild, setRebuild] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // The panel lives while the Sessions page is visible — unmount (navigating elsewhere) must
  // stop polling baseJob, otherwise it would keep running idle after it.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const load = () => api.instaboxStatus().then(setSt).catch(() => setSt({ enabled: false }));
  useEffect(() => {
    void load();
    const h = setInterval(() => void load(), 30_000);
    return () => clearInterval(h);
  }, []);

  async function rebuildBase() {
    setErr(null);
    try {
      const { jobId } = await api.rebuildBase();
      for (;;) {
        if (!alive.current) return;
        const j = await api.baseJob(jobId);
        if (!alive.current) return;
        setRebuild(JOB_STEP_LABEL[j.step] ?? j.step);
        if (j.status === "error") throw new Error(jobErrorText(j.step, j.error));
        if (j.status === "done") break;
        await new Promise((r) => setTimeout(r, 3000));
      }
      await load();
    } catch (e) { if (alive.current) setErr((e as Error).message); }
    finally { if (alive.current) setRebuild(null); }
  }

  if (!st?.enabled) return null;
  return (
    <Section label="InstaBox" meta={st.ok ? `${capacityLabel(st)} · ${bytes(st.storedBytes)} / ${bytes(st.maxStoredBytes)}` : "unavailable"}>
      <Card><CardContent className="flex flex-col gap-3 p-4 text-sm">
        {!st.ok && <p role="alert" className="text-destructive">InstaBox API is unavailable: {st.error}</p>}
        {st.ok && (!st.base || st.base.stale) && (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>{st.base ? "InstaBox base is out of date (devbox image changed)." : "InstaBox base is not built yet."}</span>
            <Button size="sm" disabled={rebuild !== null} onClick={() => void rebuildBase()}>{rebuild ? `${rebuild}…` : "Rebuild base"}</Button>
          </div>
        )}
        {st.orphans.map((o) => (
          <div key={o.id} className="flex flex-wrap items-center justify-between gap-2">
            <span>Orphaned machine {o.name} · {o.state}</span>
            <ConfirmButton variant="outline" confirmLabel="Delete machine?" onConfirm={async () => { await api.killOrphan(o.id); await load(); }} onError={setErr}>Delete machine</ConfirmButton>
          </div>
        ))}
        {(st.buildLeftovers ?? []).map((o) => (
          <div key={o.id} className="flex flex-wrap items-center justify-between gap-2">
            <span>Leftover base-build machine {o.name} · {o.state}</span>
            <ConfirmButton variant="outline" confirmLabel="Delete machine?" onConfirm={async () => { await api.killOrphan(o.id); await load(); }} onError={setErr}>Delete machine</ConfirmButton>
          </div>
        ))}
        {st.lost.map((id) => <p key={id}>Session {id} lost its machine — end it in its card below.</p>)}
        {err && <p role="alert" className="text-destructive">{err}</p>}
      </CardContent></Card>
    </Section>
  );
}
