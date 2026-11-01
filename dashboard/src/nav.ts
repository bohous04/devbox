export interface NavItem {
  to: string;
  label: string;
  glyph: string;
  /** true = the item belongs in the bottom bar on mobile (max 4 + "More"). */
  primary?: boolean;
  end?: boolean;
}

// Sidebar order. `primary` picks four items for the bottom bar on mobile —
// the rest is reachable via "More". Nine items do not fit in the bar and trimming them
// by width would mean the menu is in a different place on every phone.
export const NAV: NavItem[] = [
  { to: "/", label: "Overview", glyph: "◈", primary: true, end: true },
  { to: "/sessions", label: "Sessions", glyph: "▣", primary: true },
  { to: "/stats", label: "Statistics", glyph: "▦", primary: true },
  { to: "/subscriptions", label: "AI limits", glyph: "◇" },
  { to: "/hardware", label: "Hardware", glyph: "▚", primary: true },
  { to: "/folders", label: "Folders", glyph: "▤" },
  { to: "/log", label: "Activity", glyph: "≡" },
  { to: "/notifications", label: "Notifications", glyph: "◐" },
  { to: "/settings", label: "Settings", glyph: "✱" },
  { to: "/upkeep", label: "Agent upkeep", glyph: "↻" },
  { to: "/cron", label: "Schedules", glyph: "◷" },
  { to: "/prod-writes", label: "Production writes", glyph: "✎" },
  { to: "/operations", label: "Operations", glyph: "⚙" },
  { to: "/ssh-approvals", label: "SSH keys", glyph: "⚿" },
  // The label is "Unpushed", not "Work in progress" — same reason as for "AI subs":
  // sixteen characters wrap in the sidebar. The page title is longer.
  { to: "/unpushed", label: "Unpushed", glyph: "⇡" },
];

export const primaryNav = (): NavItem[] => NAV.filter((n) => n.primary);
export const secondaryNav = (): NavItem[] => NAV.filter((n) => !n.primary);

/** Old paths → new. Deep links from Pushover notifications and the user's bookmarks
 *  point at the old addresses, so we keep them as redirects, not 404. */
export const LEGACY_ROUTES: Record<string, string> = {
  "/projekty": "/folders",
  "/klonovani": "/folders",
  "/statistiky": "/stats",
  "/disk": "/hardware",
  "/cc-upkeep": "/upkeep",
  "/prihlaseni": "/subscriptions",
  "/aktivita": "/log",
  "/konfigurace": "/settings",
  "/plan": "/cron",
  "/prod-zapisy": "/prod-writes",
};

/** Title for the item we are on — for <title> and the header on mobile. */
export function activeLabel(pathname: string): string {
  if (pathname === "/") return "Overview";
  const hit = NAV.find((n) => n.to !== "/" && pathname.startsWith(n.to));
  return hit?.label ?? "Overview";
}

/** Visual groups share the route inventory, so no page disappears from navigation. */
export const NAV_GROUPS = [
  { label: "Workspace", routes: ["/", "/sessions", "/folders", "/stats", "/subscriptions", "/unpushed"] },
  { label: "Operations", routes: ["/cron", "/upkeep", "/prod-writes", "/operations", "/ssh-approvals"] },
  { label: "System", routes: ["/hardware", "/log", "/notifications", "/settings"] },
];
