import { useEffect, useRef, useState, type ReactNode } from "react";
import { Terminal as Xterm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { encodeBottom, encodeInput, encodeResize, encodeScroll, encodeUnlock, KEY_BAR, KEY_SEQ, terminalWsUrl, wheelSteps } from "../terminalProto";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface TerminalProps {
  /** Owner's session — WS to /api/sessions/:id/terminal. A guest passes `wsUrl` instead. */
  id?: string;
  tmux?: string;
  /** Ready-made WS address (share guest page); takes precedence over `id`. */
  wsUrl?: string;
  /** Control from the start (share guest — the server granted it right away): no read-only and no Take control. */
  startUnlocked?: boolean;
  title: string;
  /** Without onClose the Close button is not shown (the guest page has nothing to close to). */
  onClose?: () => void;
  /** Header addition next to the title (e.g. share countdown). */
  headerExtra?: ReactNode;
  /** The socket closed; `opened` = it managed to open (otherwise connect/upgrade already failed). */
  onSocketClose?: (ev: { code: number; opened: boolean }) => void;
  /** Connection state texts — overrides the default "connecting…" / "disconnected". */
  statusLabels?: { connecting: string; closed: string };
}

export function Terminal({ id, tmux, wsUrl, startUnlocked = false, title, onClose, headerExtra, onSocketClose, statusLabels }: TerminalProps) {
  const host = useRef<HTMLDivElement | null>(null);
  const [granted, setGranted] = useState(startUnlocked);
  const [status, setStatus] = useState<"connecting" | "open" | "closed">("connecting");
  const [scrolledUp, setScrolledUp] = useState(false); // "↓ Jump to end" after scrolling into history
  const termRef = useRef<Xterm | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const grantedRef = useRef(startUnlocked);
  const onSocketCloseRef = useRef(onSocketClose);
  onSocketCloseRef.current = onSocketClose;

  useEffect(() => {
    if (!host.current) return;
    const term = new Xterm({ fontFamily: "IBM Plex Mono, monospace", fontSize: 13, cursorBlink: true, theme: { background: "#0b0e14" } });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current);
    fit.fit();
    termRef.current = term;

    const ws = new WebSocket(wsUrl ?? terminalWsUrl(id ?? "", tmux));
    wsRef.current = ws;
    let opened = false;
    let disposed = false;
    ws.onopen = () => { opened = true; setStatus("open"); ws.send(encodeResize(term.cols, term.rows)); };
    ws.onmessage = (e) => { term.write(typeof e.data === "string" ? e.data : ""); };
    ws.onclose = (e) => {
      setStatus("closed");
      if (!disposed) onSocketCloseRef.current?.({ code: e.code, opened });
    };
    // Read-only: we send keys only after Take control (grantedRef).
    // Typing in copy-mode usually exits it in tmux → hide the "Jump to end" button.
    const dataSub = term.onData((d) => { if (grantedRef.current && ws.readyState === ws.OPEN) { ws.send(encodeInput(d)); setScrolledUp(false); } });
    // Wheel: the history is in tmux, not in xterm.js. Instead of mouse input ({t:"i"}, which devd
    // drops in read-only) we send {t:"s"} — works in read-only and after taking control.
    let wheelRest = 0;
    term.attachCustomWheelEventHandler((ev) => {
      ev.preventDefault();
      const lineHeight = (term.element?.querySelector(".xterm-screen")?.clientHeight ?? 0) / term.rows || 16;
      const px = ev.deltaMode === 1 ? ev.deltaY * lineHeight : ev.deltaMode === 2 ? ev.deltaY * lineHeight * term.rows : ev.deltaY;
      const st = wheelSteps(px, lineHeight, wheelRest);
      wheelRest = st.rest;
      if (st.dir && ws.readyState === ws.OPEN) {
        ws.send(encodeScroll(st.dir, st.n));
        if (st.dir === "up") setScrolledUp(true);
      }
      return false; // xterm.js does not process the wheel further
    });
    const onResize = () => { fit.fit(); if (ws.readyState === ws.OPEN) ws.send(encodeResize(term.cols, term.rows)); };
    window.addEventListener("resize", onResize);

    return () => { disposed = true; window.removeEventListener("resize", onResize); dataSub.dispose(); ws.close(); term.dispose(); };
  }, [id, tmux, wsUrl]);

  function takeControl() {
    grantedRef.current = true; setGranted(true);
    wsRef.current?.send(encodeUnlock());
    termRef.current?.focus();
  }
  function sendKey(k: string) {
    if (!grantedRef.current || wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(encodeInput(KEY_SEQ[k] ?? ""));
    setScrolledUp(false);
    termRef.current?.focus();
  }
  function toBottom() {
    if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(encodeBottom());
    setScrolledUp(false);
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-[#0b0e14] text-[#e6edf3]" role="dialog" aria-label={`Terminal ${title}`}>
      <div className="flex items-center gap-2 border-b border-[#1c2230] px-3.5 py-2.5">
        <span className="font-semibold">{title}</span>
        {!startUnlocked && <span
          className={cn(
            "rounded-full px-2 py-0.5 text-[11px] uppercase tracking-wide",
            granted ? "bg-[#1f3a24] text-[#79d88b]" : "bg-[#26303f] text-[#9fb0c3]",
          )}
        >
          {granted ? "control taken" : "read-only"}
        </span>}
        {headerExtra}
        <span className="flex-1" />
        <span className="text-xs text-[#9fb0c3]">{status === "open" ? "" : status === "connecting" ? (statusLabels?.connecting ?? "connecting…") : (statusLabels?.closed ?? "disconnected")}</span>
        {!granted && (
          <Button
            variant="outline"
            size="sm"
            className="border-[#1c2230] bg-transparent text-[#e6edf3] hover:bg-[#1c2230] hover:text-[#e6edf3]"
            onClick={takeControl}
            disabled={status !== "open"}
          >
            Take control
          </Button>
        )}
        {onClose && <Button variant="ghost" size="sm" className="text-[#9fb0c3] hover:bg-[#1c2230] hover:text-[#e6edf3]" onClick={onClose}>Close</Button>}
      </div>
      <div className="relative min-h-0 flex-1">
        <div className="h-full p-1.5" ref={host} />
        {scrolledUp && (
          <button
            className="absolute bottom-3 right-4 z-10 rounded-full bg-[#1c2230] px-3.5 py-2 text-sm text-[#e6edf3] shadow-lg hover:bg-[#26303f]"
            onMouseDown={(e) => e.preventDefault()}
            onClick={toBottom}
          >
            ↓ Jump to end
          </button>
        )}
      </div>
      {granted && (
        <div className="flex flex-wrap gap-1.5 border-t border-[#1c2230] px-2.5 py-2" style={{ paddingBottom: "calc(0.5rem + env(safe-area-inset-bottom))" }}>
          {KEY_BAR.map((k) => (
            <button
              key={k}
              className="min-h-10 min-w-11 rounded-lg border-0 bg-[#1c2230] font-sans text-[#e6edf3] hover:bg-[#26303f]"
              onMouseDown={(e) => { e.preventDefault(); sendKey(k); }}
            >
              {k}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
