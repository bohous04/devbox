// Terminal page addresses. The dashboard runs on HashRouter — routes live behind `/#/…`,
// so a link to the terminal MUST have the path in the hash. The path form (`/terminal/x`) is
// served by the server (the SPA fallback returns index.html), but the router without a hash falls to
// the catch-all and the tab lands on Overview — exactly how the Terminal button
// broke after PR #53.

/** URL for window.open from the Terminal button. */
export function terminalTabUrl(id: string): string {
  return `/#/terminal/${encodeURIComponent(id)}`;
}

/** The deep link from Pushover notifications has the PATH form `/sessions?terminal=<id>` (built by
 *  devd, see index.ts + pushChannel.sessionFromUrl — the format is kept for parsing
 *  on the server). HashRouter does not see a query OUTSIDE the hash, so before the router mounts it is
 *  translated to the terminal hash address. Returns null when the URL has no deep link. */
export function deepLinkHash(search: string): string | null {
  const id = new URLSearchParams(search).get("terminal");
  return id ? `/#/terminal/${encodeURIComponent(id)}` : null;
}
