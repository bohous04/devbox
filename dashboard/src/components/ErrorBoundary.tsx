import { Component, type ErrorInfo, type ReactNode } from "react";
import { isChunkLoadError, RELOAD_GUARD_MS, recoveryFor } from "../chunkReload";
import { Button } from "./ui/button";

/** When the page last resorted to an automatic reload. In sessionStorage
 *  deliberately: it must survive a reload (otherwise a loop could not be detected), but not
 *  closing the tab. Access is in try/catch — in strict privacy mode even reading can
 *  throw, and that would bring down exactly the rescue that is meant to catch crashes. */
const LAST_RELOAD_KEY = "devbox:chunk-reload-at";

function lastReloadAt(): number | null {
  try {
    const raw = sessionStorage.getItem(LAST_RELOAD_KEY);
    const n = raw === null ? Number.NaN : Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch { return null; }
}

function markReload(now: number): void {
  try { sessionStorage.setItem(LAST_RELOAD_KEY, String(now)); } catch { /* private mode */ }
}

interface Props { children: ReactNode; /** Description of the place, so the card shows what crashed. */ where?: string }
interface State { error: Error | null }

/** Without this boundary EVERY exception during render ends with unmounting the whole tree —
 *  React has nowhere to pass the error, `#root` stays empty and the dashboard is a white
 *  page with no menu, no message and no way back. That is exactly how
 *  a missing chunk after a deploy manifested.
 *
 *  A chunk error (see `chunkReload.ts`) is handled by the boundary itself by reloading the page —
 *  it is the only correct reaction to "a new version was released meanwhile" and the user
 *  should not have to deal with it. Anything else ends in a readable card; the menu around it stays alive,
 *  so you can click away elsewhere. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State { return { error }; }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    if (recoveryFor(error, lastReloadAt(), Date.now()) === "reload") {
      markReload(Date.now());
      location.reload();
      return;
    }
    console.error(`[${this.props.where ?? "dashboard"}]`, error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    // We get here only when the reload did not help (or it was not about a chunk at all).
    const stale = isChunkLoadError(error);
    return (
      <div className="mx-auto mt-16 max-w-lg rounded-lg border p-6" role="alert">
        <h2 className="text-lg font-semibold">
          {stale ? "This page is from an older version" : "This page failed to render"}
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {stale
            ? `A new dashboard version was deployed and reloading did not pick it up within ${RELOAD_GUARD_MS / 1000} s. If it keeps happening, your session may have expired — reload and sign in again.`
            : "The rest of the dashboard still works; pick another page in the menu or reload."}
        </p>
        <pre className="mt-3 overflow-x-auto rounded bg-muted p-2 font-mono text-xs">{error.message}</pre>
        <div className="mt-4 flex gap-2">
          <Button onClick={() => location.reload()}>Reload</Button>
          <Button variant="outline" onClick={() => this.setState({ error: null })}>Try again</Button>
        </div>
      </div>
    );
  }
}
