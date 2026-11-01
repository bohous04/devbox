import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { gateState, nextVaultStatus, VAULT_POLL_MS, type VaultStatus } from "../vaultView";
import { PageSkeleton } from "./primitives";

/** Covers the whole dashboard with an unlock prompt while the vault is locked.
 *  While the state is unknown (`null`), a skeleton is shown — the unlock prompt only after
 *  the response, otherwise it would flash even on an unlocked devd. Previously at that moment
 *  NOTHING was rendered (not even the menu) and the dashboard looked stuck on every load.
 *
 *  The state is watched CONTINUOUSLY, not only at mount. Every devd restart locks the vault (even a plain
 *  deploy) and a one-off check meant the open tab never knew about it:
 *  cards kept redrawing via the poller, so the dashboard looked alive, but the clipboard,
 *  notifications and prod-db underneath silently did not work and nowhere showed why. */
export function VaultGate({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [pass, setPass] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // `busy` must be readable inside an interval that is created only once — the ref holds
  // the current value where a closure over state would forever see the one from the first render.
  const busyRef = useRef(false);
  busyRef.current = busy;

  useEffect(() => {
    let alive = true;
    // Request failure is handled by nextVaultStatus: first time = older devd without the route (let through),
    // second time = devd is not running right now (keep what we know).
    const check = async () => {
      const poll = await api.vault().catch(() => null);
      if (alive) setStatus((prev) => nextVaultStatus(prev, poll, busyRef.current));
    };
    void check();
    const h = setInterval(() => void check(), VAULT_POLL_MS);
    return () => { alive = false; clearInterval(h); };
  }, []);

  const state = gateState(status, pass, busy);
  if (state.show === "content") return <>{children}</>;
  // Until the response from /api/vault arrives, show a skeleton — not a white page. The unlock
  // prompt may still appear only after the response, so it does not flash on an unlocked devd.
  if (state.show === "loading") {
    return (
      <div className="mx-auto w-full max-w-[1180px] px-4 pt-6 sm:px-6 lg:px-10 lg:pt-8">
        <PageSkeleton delayed />
      </div>
    );
  }

  return (
    <div className="mx-auto mt-24 max-w-md rounded-lg border p-6">
      <h2 className="text-lg font-semibold">Vault is locked</h2>
      <p className="mt-2 text-sm text-muted-foreground">
        Sessions keep running, but anything that needs credentials fails until you unlock.
      </p>
      <input
        type="password" autoFocus value={pass} aria-label="Vault passphrase"
        className="mt-4 w-full rounded border px-2 py-1"
        onChange={(e) => setPass(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && state.canSubmit) void submit(); }}
      />
      {err && <p className="mt-2 text-sm text-red-600">{err}</p>}
      <button disabled={!state.canSubmit} className="mt-3 rounded border px-3 py-1" onClick={() => void submit()}>
        {state.label}
      </button>
    </div>
  );

  async function submit() {
    setBusy(true); setErr(null);
    try { setStatus(await api.unlockVault(pass)); setPass(""); }
    catch { setErr("Wrong passphrase."); }
    finally { setBusy(false); }
  }
}
