import { AnimatePresence, motion } from "framer-motion";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
// Note: route transitions are enter-only (no AnimatePresence mode="wait") —
// exit-dependent transitions can leave a blank page when the browser pauses animations.
import { lazy, Suspense } from "react";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { BottomBar, MobileHeader, Sidebar } from "./components/Nav";
import { PageSkeleton } from "./components/primitives";
import { VaultGate } from "./components/VaultGate";
import { LEGACY_ROUTES } from "./nav";
import { Overview } from "./pages/Overview";
import { useStore } from "./store";

// Route-level code splitting: without it the bundle was a single 1.49MB chunk and recharts
// and xterm were downloaded even when the user only looked at Overview. Overview stays
// static — it is the default route, lazy loading would only add a flash there.
const AgentUpkeep = lazy(() => import("./pages/AgentUpkeep").then((m) => ({ default: m.AgentUpkeep })));
const Sessions = lazy(() => import("./pages/Sessions").then((m) => ({ default: m.Sessions })));
const Stats = lazy(() => import("./pages/Stats").then((m) => ({ default: m.Stats })));
const Subscriptions = lazy(() => import("./pages/Subscriptions").then((m) => ({ default: m.Subscriptions })));
const Hardware = lazy(() => import("./pages/Hardware").then((m) => ({ default: m.Hardware })));
const Folders = lazy(() => import("./pages/Folders").then((m) => ({ default: m.Folders })));
const Log = lazy(() => import("./pages/Log").then((m) => ({ default: m.Log })));
const Notifications = lazy(() => import("./pages/Notifications").then((m) => ({ default: m.Notifications })));
const Settings = lazy(() => import("./pages/Settings").then((m) => ({ default: m.Settings })));
const Schedule = lazy(() => import("./pages/Schedule").then((m) => ({ default: m.Schedule })));
const ProdWrites = lazy(() => import("./pages/ProdWrites").then((m) => ({ default: m.ProdWrites })));
const Operations = lazy(() => import("./pages/Operations").then((m) => ({ default: m.Operations })));
const SshApprovals = lazy(() => import("./pages/SshApprovals").then((m) => ({ default: m.SshApprovals })));
const Unpushed = lazy(() => import("./pages/Unpushed").then((m) => ({ default: m.Unpushed })));
const TerminalPage = lazy(() => import("./pages/TerminalPage").then((m) => ({ default: m.TerminalPage })));

function OfflineBar() {
  const { connected, attempted } = useStore();
  return (
    <AnimatePresence>
      {attempted && !connected && (
        <motion.div
          // bottom-20 on mobile, so the strip does not sit under the bottom bar
          className="fixed bottom-20 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-full border bg-card px-4 py-2 text-sm shadow-lg lg:bottom-4"
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 12 }}
          transition={{ duration: 0.2 }}
          role="status"
        >
          <span className="h-2 w-2 rounded-full bg-red-500" />
          connection to devd lost — retrying…
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export function App() {
  const location = useLocation();
  return (
    <VaultGate>
    <div className="min-h-screen lg:grid lg:grid-cols-[264px_minmax(0,1fr)]">
      <Sidebar />
      <MobileHeader />
      {/* pb-24 keeps content above the bottom bar; from lg the bar disappears and the padding with it */}
      <main className="mx-auto w-full max-w-[1180px] px-4 pb-24 pt-6 sm:px-6 lg:px-10 lg:pb-10 lg:pt-8">
        {/* Skeleton, not an empty area: the page chunk is downloaded only after the click,
            and until then there would otherwise be NOTHING here — the user reads that as stuck.
            The `key` on pathname is deliberate: without it React keeps the PREVIOUS page
            until the new one finishes, so after a click there is no loading indication
            at all. With the key the boundary remounts and shows the skeleton
            — but only when the chunk is really missing; an already loaded one renders immediately. */}
        {/* The boundary MUST wrap Suspense, not the other way round: the page chunk is downloaded only
            after the click, and when it cannot be downloaded (a deploy overwrote the hashes meanwhile,
            an expired Cloudflare Access session), the import is rejected and React throws that
            error during render. Without a boundary it unmounts the whole tree — a blank
            page including the menu. The `key` on pathname resets it when navigating elsewhere,
            otherwise there would be no way to click away from it. */}
        <ErrorBoundary key={location.pathname} where={location.pathname}>
        <Suspense fallback={<PageSkeleton delayed />}>
        <Routes location={location} key={location.pathname}>
          <Route path="/" element={<Overview />} />
          <Route path="/upkeep" element={<AgentUpkeep />} />
          <Route path="/sessions" element={<Sessions />} />
          <Route path="/stats" element={<Stats />} />
          <Route path="/subscriptions" element={<Subscriptions />} />
          <Route path="/hardware" element={<Hardware />} />
          <Route path="/folders" element={<Folders />} />
          <Route path="/log" element={<Log />} />
          <Route path="/notifications" element={<Notifications />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/cron" element={<Schedule />} />
          <Route path="/prod-writes" element={<ProdWrites />} />
          <Route path="/operations" element={<Operations />} />
          <Route path="/ssh-approvals" element={<SshApprovals />} />
          <Route path="/unpushed" element={<Unpushed />} />
          {/* Terminal in its own tab — the overlay component covers the menu as well. */}
          <Route path="/terminal/:id" element={<TerminalPage />} />
          {/* Old addresses keep deep links from notifications and the user's bookmarks working. */}
          {Object.entries(LEGACY_ROUTES).map(([from, to]) => (
            <Route key={from} path={from} element={<Navigate to={to} replace />} />
          ))}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        </Suspense>
        </ErrorBoundary>
      </main>
      <BottomBar />
      <OfflineBar />
    </div>
    </VaultGate>
  );
}
