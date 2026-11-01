// Pure helpers of the guest page (share.html). MUST NOT import anything from the admin dashboard
// (api.ts, store, VaultGate…) — the guest bundle is public.

const pad = (n: number) => String(n).padStart(2, "0");

/** Token from the page path `/s/<token>` (base64url, same shape as TOKEN_ROUTE in devd). */
export function shareTokenFromPath(pathname: string): string | null {
  const m = /^\/s\/([A-Za-z0-9_-]{1,128})\/?$/.exec(pathname);
  return m ? m[1] : null;
}

/** Guest terminal WS — same host as the page (devd checks the Origin of the share host). */
export function shareWsUrl(token: string, loc: { protocol: string; host: string } = window.location): string {
  const proto = loc.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${loc.host}/s/${encodeURIComponent(token)}/ws`;
}

/** Public preview of container port 3000+N → https://pN.<domain>/s/<token> (N = 0…9).
 *  The guest page runs on `share.<domain>` (DEVD_SHARE_HOST) and previews on sibling
 *  `pN.<domain>` (DEVD_PREVIEW_DOMAIN), so the domain is taken from its own address minus the first label. */
export function previewUrl(token: string, port: number, loc: { host: string } = window.location): string | null {
  const n = port - 3000;
  if (!Number.isInteger(n) || n < 0 || n > 9) return null;
  const domain = loc.host.replace(/:\d+$/, "").split(".").slice(1).join(".");
  if (!domain) return null;
  return `https://p${n}.${domain}/s/${encodeURIComponent(token)}`;
}

/** Remaining time: `m:ss`, from one hour `h:mm:ss`. Rounds up, 0:00 = expired. */
export function countdownLabel(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Expiry time: `HH:MM` today, otherwise `M/D HH:MM` (a 24h share crosses midnight). */
export function untilLabel(ts: number, now = Date.now()): string {
  const d = new Date(ts);
  const n = new Date(now);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const sameDay = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  return sameDay ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

export interface ShareInfo { name: string; expiresAt: number; ports: number[] }

/** GET /s/<token>/info → info, `null` = the share ended (404), otherwise throws (network, 429…). */
export async function fetchShareInfo(token: string): Promise<ShareInfo | null> {
  const r = await fetch(`/s/${encodeURIComponent(token)}/info`, { cache: "no-store" });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as ShareInfo;
}
