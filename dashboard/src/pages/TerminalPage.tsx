import { lazy, Suspense } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";

// Same lazy import as previously in Sessions — xterm stays in its own chunk
// (see vite.config manualChunks.terminal and chunks.test.ts).
const Terminal = lazy(() => import("../components/Terminal").then((m) => ({ default: m.Terminal })));

/** Full-page terminal in its own browser tab (route /terminal/:id).
 *  It is opened by the Terminal button in Sessions via window.open — such a tab
 *  may be closed by `window.close()`. A deep link/refresh (a tab the script did
 *  not open) ignores close, hence the fallback navigation back to Sessions. */
export function TerminalPage() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  if (!id) return null; // the router does not route here without :id, this is just for the types

  return (
    <Suspense fallback={null}>
      <Terminal
        id={id}
        tmux={params.get("tmux") ?? undefined}
        title={id}
        onClose={() => {
          window.close();
          setTimeout(() => navigate("/sessions", { replace: true }), 150);
        }}
      />
    </Suspense>
  );
}
