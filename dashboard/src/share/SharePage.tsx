import { useCallback, useEffect, useState } from "react";
import { Terminal } from "../components/Terminal";
import { countdownLabel, fetchShareInfo, previewUrl, shareTokenFromPath, shareWsUrl, untilLabel, type ShareInfo } from "./guest";

/** WS close code when the share was revoked by the owner or expired (CLOSE_ENDED in devd). */
const CLOSE_ENDED = 4001;
/** How often to refresh /info — preview ports appear once the agent starts a dev server. */
const INFO_REFRESH_MS = 30_000;

type State =
  | { kind: "loading" }
  | { kind: "ended" }
  | { kind: "error" }
  | { kind: "live"; info: ShareInfo };

export function SharePage() {
  const [token] = useState(() => shareTokenFromPath(window.location.pathname));
  const [state, setState] = useState<State>(() => (token ? { kind: "loading" } : { kind: "ended" }));
  const [dropped, setDropped] = useState(false); // connection dropped, but the share is still valid
  const [attempt, setAttempt] = useState(0);     // terminal key → new connection
  const [now, setNow] = useState(() => Date.now());

  const loadInfo = useCallback(async (): Promise<ShareInfo | null | undefined> => {
    if (!token) return null;
    try {
      const info = await fetchShareInfo(token);
      // An ended share never comes back (even if a response arrives after 4001).
      setState((prev): State => (prev.kind === "ended" ? prev : info ? { kind: "live", info } : { kind: "ended" }));
      return info;
    } catch {
      setState((prev) => (prev.kind === "loading" ? { kind: "error" } : prev));
      return undefined;
    }
  }, [token]);

  const ended = state.kind === "ended";
  useEffect(() => {
    if (ended) return; // fetch nothing after the end (an invalid token would only fill the rate limit)
    void loadInfo();
    const h = setInterval(() => void loadInfo(), INFO_REFRESH_MS);
    return () => clearInterval(h);
  }, [loadInfo, ended]);

  useEffect(() => {
    const h = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(h);
  }, []);

  // Expiry is not decided by the local clock (it can drift from the server): devd closes the WS with code
  // 4001 and /info then returns 404. The countdown is informational only.

  // 4001 = share ended. Any other close (including a failed connect — the server rejects an invalid token
  // before the upgrade) is decided by /info: 404 = ended, otherwise just a dropped connection.
  const onSocketClose = useCallback(async ({ code }: { code: number; opened: boolean }) => {
    if (code === CLOSE_ENDED) { setState({ kind: "ended" }); return; }
    const info = await loadInfo();
    if (info !== null) setDropped(true);
  }, [loadInfo]);

  if (state.kind === "loading") return <Centered title="Connecting…" />;
  if (state.kind === "ended") return <Centered title="Sharing ended" text="This link is no longer valid — the share expired or the owner revoked it." />;
  if (state.kind === "error" || !token) {
    return <Centered title="Couldn't load the share" text="Check your connection and try reloading the page." action={{ label: "Reload", onClick: () => window.location.reload() }} />;
  }

  const info = state.info;
  const previews = info.ports.flatMap((p) => { const url = previewUrl(token, p); return url ? [{ port: p, url }] : []; });

  return (
    <>
      <Terminal
        key={attempt}
        wsUrl={shareWsUrl(token)}
        startUnlocked
        title={info.name}
        onSocketClose={onSocketClose}
        headerExtra={
          <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[#9fb0c3]">
            <span>valid until {untilLabel(info.expiresAt, now)} <span className="tabular-nums">({countdownLabel(info.expiresAt - now)} left)</span></span>
            {previews.map((p) => (
              <a key={p.port} href={p.url} target="_blank" rel="noopener noreferrer" className="rounded-full bg-[#1c2230] px-2 py-0.5 text-[#e6edf3] hover:bg-[#26303f]">
                Preview :{p.port}
              </a>
            ))}
          </span>
        }
      />
      {dropped && (
        <div role="status" className="fixed bottom-20 left-1/2 z-[60] flex -translate-x-1/2 items-center gap-3 rounded-lg bg-[#1c2230] px-4 py-2.5 text-sm text-[#e6edf3] shadow-lg">
          Connection lost.
          <button className="rounded-md bg-[#26303f] px-3 py-1.5 hover:bg-[#33405a]" onClick={() => { setDropped(false); setAttempt((a) => a + 1); }}>
            Reconnect
          </button>
        </div>
      )}
    </>
  );
}

function Centered({ title, text, action }: { title: string; text?: string; action?: { label: string; onClick: () => void } }) {
  return (
    <main className="mx-auto max-w-md px-4 pt-[15vh] text-center font-sans">
      <h1 className="text-xl font-semibold">{title}</h1>
      {text && <p className="mt-3 text-sm text-[#9fb0c3]">{text}</p>}
      {action && (
        <button className="mt-5 rounded-md bg-[#1c2230] px-4 py-2 text-sm hover:bg-[#26303f]" onClick={action.onClick}>{action.label}</button>
      )}
    </main>
  );
}
