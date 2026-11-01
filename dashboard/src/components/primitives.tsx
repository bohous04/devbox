import type { ComponentProps, MouseEvent, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowDown, ArrowUp, ChevronRight, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/** Input for a MACHINE secret — gitea token, API key, credentials blob. Masked,
 *  but invisible to password managers.
 *
 *  Why: `type="password"` alone is enough for 1Password (and co.) to pop up
 *  "Save login" after filling it in — and that dialog has "Update Existing" preselected above
 *  the list of your items. One wrong click and the password of an unrelated item in the
 *  vault is overwritten with a JSON blob of OAuth tokens. Offering to save makes no sense either:
 *  none of this is a login credential that would be filled in somewhere again.
 *
 *  Data attributes are the only reliable way out, each manager has its own; plain
 *  `autocomplete="off"` is commonly ignored. Masking STAYS — the value is a real
 *  secret and this page is often shared as a screenshot.
 *
 *  Note: the vault password field (VaultGate) DELIBERATELY does not use this — that is a
 *  real password and saving it in a manager is legitimate. */
export function SecretInput(props: ComponentProps<typeof Input>) {
  return (
    <Input
      type="password"
      autoComplete="off"
      data-1p-ignore=""         // 1Password
      data-lpignore="true"      // LastPass
      data-bwignore="true"      // Bitwarden
      data-form-type="other"    // Dashlane
      {...props}
    />
  );
}

export function AppPage({ title, sub, actions, children }: { title: string; sub?: string; actions?: ReactNode; children: ReactNode }) {
  useEffect(() => { document.title = `devbox · ${title}`; }, [title]);
  return (
    <motion.div initial={false}>
      {/* Title and actions stack vertically on a narrow display — otherwise
          a long DateRangePicker would push into the heading and break the header height. */}
      <header className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-semibold tracking-tight">{title}</h1>
          {sub && <p className="mt-1 text-sm text-muted-foreground">{sub}</p>}
        </div>
        {actions && <div className="flex-none">{actions}</div>}
      </header>
      {children}
    </motion.div>
  );
}

export function Section({ label, meta, children }: { label: string; meta?: ReactNode; children?: ReactNode }) {
  return (
    <section className="mb-5">
      <div className="mb-2 flex min-h-8 items-center justify-between gap-3">
        <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{label}</span>
        {meta}
      </div>
      {children}
    </section>
  );
}

/* ============================== akce ============================== */

/** A button that holds its own "in progress" state. Over VPN there is latency and without this
 *  the user does not know the click registered — which is why EVERY dashboard action goes through it.
 *  It does not change width (the spinner replaces the icon, the label stays), so nothing
 *  jumps around in the action grid. The error is reported up via onError and also stays in title. */
export function ActionButton({
  onAction, onError, icon, children, className, disabled, title, ...rest
}: Omit<ComponentProps<typeof Button>, "onClick" | "onError"> & {
  onAction: () => void | Promise<void>;
  onError?: (msg: string) => void;
  icon?: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  async function go(e: MouseEvent) {
    e.stopPropagation();
    if (busy) return;
    setBusy(true);
    setFailed(null);
    try {
      await onAction();
    } catch (err) {
      const msg = (err as Error).message || "action failed";
      if (alive.current) setFailed(msg);
      onError?.(msg);
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  return (
    <Button
      {...rest}
      disabled={disabled || busy}
      aria-busy={busy}
      title={failed ?? title}
      className={cn(failed && "border-destructive text-destructive", className)}
      onClick={go}
    >
      {busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : icon}
      {children}
    </Button>
  );
}

/** How long the button stays armed before it returns to rest by itself. The original 2.6 s
 *  was so short it could not be told apart from a broken button: whoever just missed the first
 *  click with their eyes saw "I clicked End and nothing happened" — and the second click landed
 *  on a disarmed button, so it only armed again. */
export const CONFIRM_ARM_MS = 6000;

/** Two-phase destructive action: the first click arms, the second executes. Arming
 *  wears off by itself (CONFIRM_ARM_MS), so an accidentally armed button does not stay as a trap. */
export function ConfirmButton({
  onConfirm, onError, confirmLabel = "Sure?", children, className, size = "sm", ...rest
}: Omit<ComponentProps<typeof Button>, "onClick" | "onError"> & {
  onConfirm: () => void | Promise<void>;
  onError?: (msg: string) => void;
  confirmLabel?: ReactNode;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), CONFIRM_ARM_MS);
    return () => clearTimeout(t);
  }, [armed]);

  if (!armed) {
    return (
      <Button
        {...rest}
        size={size}
        title="Destructive — needs a second click to confirm"
        className={cn("text-destructive hover:bg-destructive/10 hover:text-destructive", className)}
        onClick={(e) => { e.stopPropagation(); setArmed(true); }}
      >
        {children}
      </Button>
    );
  }
  return (
    <ActionButton
      {...rest}
      size={size}
      variant="destructive"
      title="Click to confirm"
      // The label change is the only thing that signals arming — without an announcement a screen
      // reader would not even report it and the second click would go blind.
      aria-live="polite"
      className={className}
      onError={onError}
      onAction={async () => { try { await onConfirm(); } finally { setArmed(false); } }}
    >
      {confirmLabel}
    </ActionButton>
  );
}

/** Grid of action buttons with fixed columns. This is the fix for the main complaint —
 *  previously the buttons were in a `flex-wrap` row and wrapped by the session name length,
 *  so every card had them somewhere else. In the grid each button has its own cell. */
export function ActionRow({ cols = 3, className, children }: { cols?: 2 | 3 | 4; className?: string; children: ReactNode }) {
  const grid = cols === 2 ? "grid-cols-2" : cols === 3 ? "grid-cols-2 sm:grid-cols-3" : "grid-cols-2 sm:grid-cols-4";
  return <div className={cn("grid gap-2 [&>*]:w-full", grid, className)}>{children}</div>;
}

/* ============================== display ============================== */

export function StatCard({ label, value, unit, sub, delta, tone }: { label: string; value: ReactNode; unit?: string; sub?: string; delta?: number | null; tone?: "warn" | "ok" }) {
  const showDelta = delta != null && Number.isFinite(delta);
  return (
    <Card className="min-h-[96px]">
      <CardContent className="p-4">
        <div className="truncate text-xs font-medium uppercase tracking-wider text-muted-foreground">{label}</div>
        <div className={cn("mt-1 font-mono text-2xl font-semibold tabular-nums", tone === "warn" && "text-amber-600 dark:text-amber-400", tone === "ok" && "text-emerald-600 dark:text-emerald-400")}>
          {value}{unit && <span className="ml-1 text-base text-muted-foreground">{unit}</span>}
        </div>
        {showDelta && (
          <div className={cn("mt-1 flex items-center gap-1 text-xs", delta >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400")}>
            {delta >= 0 ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />}
            {Math.abs(Math.round(delta))} % vs. previous period
          </div>
        )}
        {sub && !showDelta && <div className="mt-1 truncate text-xs text-muted-foreground">{sub}</div>}
      </CardContent>
    </Card>
  );
}

/** Metrics strip with a fixed cell height — uptime / CPU / RAM / tokens / cost. */
export function StatGrid({ items }: { items: { label: string; value: ReactNode }[] }) {
  return (
    <div className="grid grid-cols-2 divide-x divide-y overflow-hidden rounded-md border bg-muted/40 sm:grid-cols-3 lg:grid-cols-5">
      {items.map((it) => (
        <div key={it.label} className="flex h-[58px] flex-col items-center justify-center px-2">
          <div className="text-[9.5px] font-semibold uppercase tracking-wider text-muted-foreground">{it.label}</div>
          <div className="mt-0.5 w-full truncate text-center font-mono text-sm font-semibold tabular-nums">{it.value}</div>
        </div>
      ))}
    </div>
  );
}

const DOT: Record<string, string> = {
  working: "bg-emerald-500", waiting: "bg-amber-500", idle: "bg-zinc-400",
  running: "bg-emerald-500", stopped: "bg-zinc-400", ok: "bg-emerald-500", off: "bg-zinc-400", danger: "bg-red-500",
};
export function StatusDot({ kind, pulse }: { kind: keyof typeof DOT | string; pulse?: boolean }) {
  return (
    <span className="relative inline-flex h-2 w-2 flex-none">
      {pulse && <span className={cn("absolute inline-flex h-full w-full animate-ping rounded-full opacity-60", DOT[kind] ?? "bg-zinc-400")} />}
      <span className={cn("relative inline-flex h-2 w-2 rounded-full", DOT[kind] ?? "bg-zinc-400")} />
    </span>
  );
}

/** Expandable row chevron — rotates when the content below is open. */
export function Chevron({ open }: { open: boolean }) {
  return <ChevronRight className={cn("size-3.5 flex-none text-muted-foreground transition-transform", open && "rotate-90")} aria-hidden="true" />;
}

/** Collapsible content with a uniform height animation. `overflow-hidden` keeps nested
 *  expansion (e.g. a branch inside a repo) within the animated height — but it also clips
 *  anything that would want to overflow outside (popover, dropdown); do not use it there. */
export function Collapse({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
          transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }} className="overflow-hidden">
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export function EmptyState({ title, hint, icon, action }: { title: string; hint?: string; icon?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-8 text-center">
      {icon && <div className="mb-2 text-2xl text-muted-foreground">{icon}</div>}
      <div className="font-medium">{title}</div>
      {hint && <div className="mt-1 max-w-sm text-sm text-muted-foreground">{hint}</div>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

/** Skeleton shaped as a list of rows — waiting should look like the content to come. */
export function RowsSkeleton({ rows = 4, height = 56 }: { rows?: number; height?: number }) {
  return (
    <div className="flex flex-col gap-2">
      {Array.from({ length: rows }, (_, i) => <Skeleton key={i} className="w-full rounded-lg" style={{ height }} />)}
    </div>
  );
}

export function CardsSkeleton({ count = 3, className }: { count?: number; className?: string }) {
  return (
    <div className={cn("grid gap-3 sm:grid-cols-3", className)}>
      {Array.from({ length: count }, (_, i) => <Skeleton key={i} className="h-[104px] rounded-lg" />)}
    </div>
  );
}

/** Skeleton of the WHOLE page — for the moment when not even its code is loaded.
 *  Its shape copies AppPage (heading, subtitle, cards, list), so content arriving
 *  does not make the layout jump. Used by the Suspense fallback while the
 *  route chunk loads and by the vault gate until it knows the state — both used to show
 *  an empty area and it looked like a stuck dashboard.
 *
 *  `delayed` makes it appear only after ~120 ms (see .skeleton-delayed in index.css).
 *  A short wait thus stays unchanged instead of flashing gray rectangles;
 *  a longer wait shows the skeleton. */
export function PageSkeleton({ delayed = false }: { delayed?: boolean }) {
  return (
    <div aria-busy="true" aria-label="Loading" className={delayed ? "skeleton-delayed" : undefined}>
      <header className="mb-5">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="mt-2 h-4 w-80" />
      </header>
      <CardsSkeleton count={3} className="mb-5" />
      <RowsSkeleton rows={3} />
    </div>
  );
}

/** Horizontally scrollable wrapper for tables and charts — the page itself must never
 *  scroll horizontally, even when the content is wider than a phone. */
export function ScrollX({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("w-full overflow-x-auto", className)}>{children}</div>;
}

/** Simple pagination under long lists. */
export function Pager({ page, pages, onPage }: { page: number; pages: number; onPage: (p: number) => void }) {
  if (pages <= 1) return null;
  return (
    <div className="mt-3 flex items-center justify-between gap-3">
      <Button variant="outline" size="sm" disabled={page <= 0} onClick={() => onPage(page - 1)}>← Previous</Button>
      <span className="font-mono text-xs text-muted-foreground">{page + 1} / {pages}</span>
      <Button variant="outline" size="sm" disabled={page >= pages - 1} onClick={() => onPage(page + 1)}>Next →</Button>
    </div>
  );
}
