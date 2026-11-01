import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { Button } from "@/components/ui/button";
import { reconnectLink, refreshDelayMs, shouldRevokeOnClose } from "../instaboxView";

type Link = { url: string; expiresAt: number };

// Desktop InstaBox VM in an iframe (stream link without sign-in → short TTL, issued only by
// devd behind CF Access). Default is view-only; "Take control" requests a link with control
// (devd invalidates old links in the process), "Give back" invalidates it and returns to viewing.
// M7: the iframe stays connected until the mode changes or the user hits Reconnect —
// periodic link renewal only stores a fresh link (without invalidation) for reconnecting.
export function DesktopModal({ sessionId, title, onClose }: { sessionId: string; title: string; onClose: () => void }) {
  const [control, setControl] = useState(false);
  const [link, setLink] = useState<Link | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // Ref, not state: the cleanup function of the unmount effect below reads the CURRENT value at the moment
  // the component goes away, not the value captured at mount.
  const controlRef = useRef(control);
  controlRef.current = control;
  // Last pre-renewed link — the iframe gets it only on Reconnect.
  const fresh = useRef<Link | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let alive = true;
    fresh.current = null;
    const schedule = (l: Link) => { timer = setTimeout(() => void refresh(), refreshDelayMs(l.expiresAt, Date.now())); };
    // Renewal: refresh=true → devd invalidates nothing (not even in control mode).
    const refresh = async () => {
      try {
        const l = await api.desktopLink(sessionId, control, true);
        if (!alive) return;
        fresh.current = l;
        schedule(l);
      } catch (e) { if (alive) setErr((e as Error).message); }
    };
    // First link of a mode: the only place where the iframe src changes (control → devd invalidates the old ones).
    void (async () => {
      try {
        const l = await api.desktopLink(sessionId, control);
        if (!alive) return;
        setLink(l); setErr(null);
        schedule(l);
      } catch (e) { if (alive) setErr((e as Error).message); }
    })();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [sessionId, control]);

  const reconnect = async () => {
    try {
      const l = reconnectLink(fresh.current, Date.now()) ?? await api.desktopLink(sessionId, control, true);
      fresh.current = null;
      setLink(l); setErr(null);
    } catch (e) { setErr((e as Error).message); }
  };

  // Close (or any other unmount, e.g. switching to another session) with control active
  // would otherwise leave an unauthenticated control link hanging — invalidate it
  // independently of the Give back button. Fire-and-forget, must not block closing the modal.
  useEffect(() => {
    return () => {
      if (shouldRevokeOnClose(controlRef.current)) {
        void api.desktopRevoke(sessionId).catch(() => { console.warn("desktop: failed to revoke control link on close"); });
      }
    };
  }, [sessionId]);

  const giveBack = async () => {
    await api.desktopRevoke(sessionId).catch(() => { console.warn("desktop: failed to revoke control link"); });
    setControl(false);
  };

  return (
    <div role="dialog" aria-modal="true" aria-label={`${title} desktop`} className="fixed inset-0 z-50 flex flex-col bg-background">
      <div className="flex items-center gap-2 border-b p-2">
        <span className="font-medium">{title} · Desktop</span>
        <span className="text-sm text-muted-foreground">{control ? "you are in control" : "view only"}</span>
        <div className="ml-auto flex gap-2">
          {control
            ? <Button size="sm" variant="outline" onClick={() => void giveBack()}>Give back to agent</Button>
            : <Button size="sm" onClick={() => setControl(true)}>Take control</Button>}
          <Button size="sm" variant="ghost" onClick={() => void reconnect()}>Reconnect</Button>
          <Button size="sm" variant="ghost" onClick={onClose}>Close</Button>
        </div>
      </div>
      {err && <p role="alert" className="p-4 text-sm text-destructive">{err}</p>}
      {link && <iframe key={link.url} src={link.url} title={`${title} desktop`} className="w-full flex-1 border-0" allow="clipboard-read; clipboard-write" />}
    </div>
  );
}
