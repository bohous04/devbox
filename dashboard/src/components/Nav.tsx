import { LayoutDashboard, Terminal, ChartNoAxesCombined, Gauge, Server, Folder, List, Bell, Settings, CalendarClock, ListChecks, Wrench, KeyRound, GitCommitHorizontal } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { cn } from "@/lib/utils";
import { agoLabel } from "../format";
import { NAV, NAV_GROUPS, primaryNav, secondaryNav, type NavItem } from "../nav";
import { useNow, useStore } from "../store";
import { StatusDot } from "./primitives";
import { ModeToggle } from "./theme";

const NAV_ICONS = { "/": LayoutDashboard, "/sessions": Terminal, "/stats": ChartNoAxesCombined, "/subscriptions": Gauge, "/hardware": Server, "/folders": Folder, "/log": List, "/notifications": Bell, "/settings": Settings, "/cron": CalendarClock, "/prod-writes": ListChecks, "/operations": Wrench, "/ssh-approvals": KeyRound, "/unpushed": GitCommitHorizontal, "/upkeep": Wrench };
function NavIcon({ to }: { to: string }) { const Icon = NAV_ICONS[to as keyof typeof NAV_ICONS] ?? List; return <Icon aria-hidden="true" className="size-4 shrink-0" strokeWidth={1.7} />; }

function BrandMark() {
  return (
    <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground"><Terminal aria-hidden="true" className="size-5" strokeWidth={1.8} /></div>
  );
}

/** Number of running sessions as a badge on the Sessions item. */
function useRunningCount(): number {
  const { live } = useStore();
  return live?.sessions.filter((s) => s.status === "running").length ?? 0;
}

function ConnectionFoot() {
  const { version, connected, lastUpdated } = useStore();
  const now = useNow(1000);
  return (
    <div className="space-y-2 px-2 pt-4 text-xs text-muted-foreground">
      <div className="flex items-center gap-2">
        <StatusDot kind={connected ? "ok" : "off"} />
        {connected ? "connected" : "disconnected"}
      </div>
      <div className="flex items-center justify-between">
        <span>{lastUpdated !== null ? `updated ${agoLabel(now - lastUpdated)}` : "waiting for data…"}</span>
        <ModeToggle />
      </div>
      {version && <div>devd v{version}</div>}
    </div>
  );
}

function ItemLink({ n, running, onNavigate }: { n: NavItem; running: number; onNavigate?: () => void }) {
  const { pendingWrites } = useStore();
  return (
    <NavLink
      to={n.to}
      end={n.end}
      onClick={onNavigate}
      className={({ isActive }) =>
        cn(
          "flex min-h-10 shrink-0 items-center gap-3 rounded-lg px-3 text-sm text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground",
          isActive && "bg-accent font-medium text-foreground",
        )
      }
    >
      {() => (
        <>
          <NavIcon to={n.to} />
          <span className="truncate">{n.label}</span>
          {n.to === "/prod-writes" && pendingWrites !== null && pendingWrites > 0 && <span aria-label={`${pendingWrites} waiting production writes`} className="ml-auto rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-semibold tabular-nums text-amber-700 dark:text-amber-400">{pendingWrites}</span>}
          {n.to === "/sessions" && running > 0 && (
            <span className="ml-auto text-xs font-medium tabular-nums text-foreground">{running}</span>
          )}
        </>
      )}
    </NavLink>
  );
}

function GroupedLinks({ items, running, onNavigate }: { items: NavItem[]; running: number; onNavigate?: () => void }) {
  return <>{NAV_GROUPS.map((group) => {
    const links = group.routes.flatMap((route) => items.filter((item) => item.to === route));
    return links.length ? <div key={group.label} className="space-y-1">
      <p className="mb-2 px-3 text-xs font-medium text-muted-foreground">{group.label}</p>
      {links.map((n) => <ItemLink key={n.to} n={n} running={running} onNavigate={onNavigate} />)}
    </div> : null;
  })}</>;
}

/** Desktop sidebar; the same visual grouping also appears in mobile More. */
export function Sidebar() {
  const running = useRunningCount();
  return (
    <aside className="sticky top-0 hidden h-dvh min-h-0 flex-col border-r bg-card lg:flex">
      <NavLink to="/" className="flex h-20 shrink-0 items-center gap-3 px-5">
        <BrandMark />
        <span className="whitespace-nowrap text-base font-semibold tracking-tight">Devbox<span className="ml-2 font-normal text-muted-foreground">/ workspace</span></span>
      </NavLink>
      <nav className="min-h-0 flex-1 space-y-5 overflow-y-auto px-3 pb-5 pt-2" aria-label="Main navigation">
        <GroupedLinks items={NAV} running={running} />
      </nav>
      <div className="shrink-0 border-t px-3 pb-3"><ConnectionFoot /></div>
    </aside>
  );
}

/** Mobile header — just the brand and the theme toggle; navigation is at the bottom by the thumb. */
export function MobileHeader() {
  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b bg-background/85 px-4 backdrop-blur lg:hidden">
      <BrandMark />
      <span className="text-sm font-semibold tracking-tight">Devbox <span className="ml-1 font-normal text-muted-foreground">/ workspace</span></span>
      <span className="flex-1" />
      <ModeToggle />
    </header>
  );
}

/** Bottom bar: 4 main items + "More". Nine items would not fit in the bar,
 *  so the rest goes into a slide-out panel — but the four used the most
 *  are one tap away. */
export function BottomBar() {
  const running = useRunningCount();
  const [moreOpen, setMoreOpen] = useState(false);
  const location = useLocation();
  const { pendingWrites } = useStore();
  const rest = secondaryNav();
  const onRest = rest.some((n) => location.pathname.startsWith(n.to));

  // Navigating to another page closes the panel — otherwise it would stay hanging over the content.
  useEffect(() => { setMoreOpen(false); }, [location.pathname]);

  return (
    <>
      <AnimatePresence>
        {moreOpen && (
          <>
            <motion.div
              className="fixed inset-0 z-40 bg-black/40 lg:hidden"
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              onClick={() => setMoreOpen(false)}
              aria-hidden="true"
            />
            <motion.div
              className="fixed inset-x-0 bottom-[64px] z-40 max-h-[calc(100dvh-80px)] overflow-y-auto rounded-t-2xl border-t bg-card px-3 pb-3 pt-4 shadow-2xl lg:hidden"
              initial={{ y: "100%" }} animate={{ y: 0 }} exit={{ y: "100%" }}
              transition={{ type: "spring", stiffness: 420, damping: 38 }}
              role="dialog"
              aria-label="More navigation"
            >
              <nav className="space-y-4">
                <GroupedLinks items={rest} running={running} onNavigate={() => setMoreOpen(false)} />
              </nav>
              <div className="mt-2 border-t pt-1">
                <ConnectionFoot />
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      <nav
        className="fixed inset-x-0 bottom-0 z-50 grid h-16 grid-cols-5 border-t bg-background/95 backdrop-blur lg:hidden"
        aria-label="Main navigation"
      >
        {primaryNav().map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            end={n.end}
            className={({ isActive }) =>
              cn(
                "relative flex flex-col items-center justify-center gap-1 text-[10px] font-medium text-muted-foreground transition-colors active:bg-accent",
                isActive && "text-foreground",
              )
            }
          >
            <NavIcon to={n.to} />
            {n.label}
            {n.to === "/sessions" && running > 0 && (
              <span className="absolute right-[22%] top-2 h-1.5 w-1.5 rounded-full bg-primary" />
            )}
          </NavLink>
        ))}
        <button
          className={cn(
            "flex flex-col items-center justify-center gap-1 text-[10px] font-medium text-muted-foreground transition-colors active:bg-accent",
            (moreOpen || onRest) && "text-foreground",
          )}
          onClick={() => setMoreOpen((o) => !o)}
          aria-expanded={moreOpen}
        >
          <span aria-hidden="true" className="text-lg leading-none">⋯</span>
          More{pendingWrites !== null && pendingWrites > 0 && <span className="rounded-full bg-amber-500/15 px-2 text-amber-700 dark:text-amber-400">{pendingWrites}</span>}
        </button>
      </nav>
    </>
  );
}
