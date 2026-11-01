// The profile's credentials blob and access token refresh. Measured on a real blob:
// accessToken ~8 h, refreshToken ~28 days (rolling — renewed on every use).
// Refresh is normally done by Claude Code itself while running; this is a safeguard for an
// account nobody has used for a long time — without it it would gradually go blind and the
// poller would stop reading its quota.

export const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
export const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

export interface CredentialsBlob {
  claudeAiOauth: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    refreshTokenExpiresAt?: number;
    scopes?: string[];
    subscriptionType?: string;
    rateLimitTier?: string;
  };
}

/** Blob from the profile. `null` = missing, not JSON, or lacks both tokens — in none
 *  of those cases can it be worked with and the account belongs in quarantine. */
export function parseCredentials(raw: string): CredentialsBlob | null {
  let j: unknown;
  try { j = JSON.parse(raw); } catch { return null; }
  const o = (j as CredentialsBlob | null)?.claudeAiOauth;
  if (!o || typeof o.accessToken !== "string" || typeof o.refreshToken !== "string") return null;
  return j as CredentialsBlob;
}

/** Input from the "credentials" field in the dashboard. `parseCredentials` is not enough
 *  for it: what the user copies with the mouse from a terminal is not bare JSON.
 *
 *  Specifically: `.credentials.json` does not end with a newline, so zsh draws an
 *  inverted `%` after the `cat` output — and it gets copied along. `JSON.parse` fails on
 *  it and the only message the field had read "must be the contents of .credentials.json with
 *  claudeAiOauth", i.e. exactly what the pasted text was. It looked as if
 *  pasting did not work. The leading shell prompt or apostrophes around the blob can end up
 *  here the same way.
 *
 *  So the piece from the first `{` to the last `}` is cut out of the text and only that is
 *  parsed. `text` is exactly that cut-out part — IT is WRITTEN to the profile, not
 *  the original input, otherwise the `%` would end up in the file and break Claude Code inside
 *  the container.
 *
 *  The error reason is returned separately: "it is not JSON" and "it is JSON, but a different file"
 *  are fixed differently and collapsing them into one sentence was half the problem. */
export type CredentialsInput =
  | { ok: true; text: string; blob: CredentialsBlob }
  | { ok: false; reason: "empty" | "not-json" | "not-credentials" };

export function normalizeCredentialsInput(raw: string): CredentialsInput {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: false, reason: "empty" };

  // First the text as it came; only when that does not pass, the cut-out variant —
  // so clean input is never overwritten by a trim that could cut something off.
  const carved = trimmed.slice(trimmed.indexOf("{"), trimmed.lastIndexOf("}") + 1);
  const candidates = carved && carved !== trimmed ? [trimmed, carved] : [trimmed];

  let sawJson = false;
  for (const text of candidates) {
    let j: unknown;
    try { j = JSON.parse(text); } catch { continue; }
    sawJson = true;
    const blob = parseCredentials(text);
    if (blob) return { ok: true, text, blob };
  }
  return { ok: false, reason: sawJson ? "not-credentials" : "not-json" };
}

/** Message for the reason — one place for both routes (add and replace). */
export function credentialsInputError(reason: "empty" | "not-json" | "not-credentials"): string {
  switch (reason) {
    case "empty": return "credentials are empty — paste the contents of .credentials.json";
    case "not-json": return "credentials are not valid JSON — only part of the blob was copied,"
      + " or a line break crept into it. The safest way is `pbcopy` instead of copying with the mouse.";
    case "not-credentials": return "this is JSON, but it has no claudeAiOauth.accessToken and refreshToken —"
      + " it looks like a different file than .credentials.json";
  }
}

// 5 min margin: a token that expires during the call is already expired for us.
const DEFAULT_SKEW_MS = 5 * 60_000;

export function accessTokenExpired(b: CredentialsBlob, now: number, skewMs = DEFAULT_SKEW_MS): boolean {
  const exp = b.claudeAiOauth.expiresAt;
  return typeof exp !== "number" || !Number.isFinite(exp) || exp - skewMs <= now;
}

/** Dead refresh token = the account must log in again. A missing field does not mean
 *  dead — older blobs may not have it and guessing would mean quarantining a healthy account. */
export function refreshTokenDead(b: CredentialsBlob, now: number): boolean {
  const exp = b.claudeAiOauth.refreshTokenExpiresAt;
  return typeof exp === "number" && Number.isFinite(exp) && exp <= now;
}

// Recognizes the plan multiplier from `rateLimitTier` (the exact shape is "default_claude_max_5x",
// "default_claude_max_20x", ...). Used by accountPolicy.chooseAccount to weight the
// remaining capacity — a 20× account really has more room than a 5× one at the same percentage.
const TIER_RE = /^default_claude_max_(\d+)x$/;

/** `null` = unknown or unparseable tier (missing field, different shape, a plan with
 *  multiplier 0). NEVER guess a default weight (e.g. 1) — accountPolicy must in that
 *  case fall back to the unweighted policy, not get a falsely low number next to
 *  which the 20× account would look like the only sensible choice even where the percentages
 *  say otherwise (see the comment at `weighted` in accountPolicy.ts). */
export function parseTierWeight(tier: string | null | undefined): number | null {
  if (typeof tier !== "string") return null;
  const m = TIER_RE.exec(tier);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// A suffix at the end of the label that this same code may have added earlier — removed
// before adding a new one, so they do not pile up ("(Max 5x) (Max 5x)") on repeated calls
// from the poller, nor stay stale after a plan upgrade/downgrade.
const TIER_SUFFIX_RE = / \(Max \d+x\)$/;

/** Appends/updates "(Max Nx)" at the end of the label according to the account weight — the
 *  operator otherwise confuses which of the two accounts is the "big" one (see the misleading
 *  `primary`/`backup` ids). Idempotent: safe to call on EVERY successful poll, not just once at
 *  registration. `weight === null` only strips the old suffix from the label (a degraded/unknown
 *  tier has nothing to show off). */
export function withTierLabel(label: string, weight: number | null): string {
  const base = label.replace(TIER_SUFFIX_RE, "");
  return weight !== null ? `${base} (Max ${weight}x)` : base;
}

export type RefreshResult =
  | { ok: true; blob: CredentialsBlob }
  | { ok: false; dead: boolean; error: string };

/** From the error response body we take ONLY the well-known `error` / `error_description`
 *  fields, never raw text. We do not control the endpoint — an error response could in theory
 *  echo back other fields from the request (in our case that would be the refresh token), and
 *  raw text would carry them all the way into the error message the caller logs. A non-JSON body
 *  or a body without those fields → empty detail, no crash. */
function extractErrorDetail(bodyText: string): string {
  let j: unknown;
  try { j = JSON.parse(bodyText); } catch { return ""; }
  if (!j || typeof j !== "object") return "";
  const o = j as Record<string, unknown>;
  return [o.error, o.error_description]
    .filter((v): v is string => typeof v === "string")
    .join(": ")
    .slice(0, 200);
}

/** `dead: true` (4xx, EXCEPT 408 and 429) = the refresh token is invalid → quarantine.
 *  `dead: false` (5xx, network, 408 timeout, 429 rate limit) = transient error →
 *  retried next time, the account stays in rotation with the last numbers. 408/429 are not
 *  "the refresh token is bad", they are "the token endpoint cannot keep up right now" — quarantine
 *  would remove the account from rotation (message "Re-login needed") because of overload, not
 *  because of a really dead token (minor fix, review round 4).
 *
 *  `now` is a parameter (default `Date.now()`) just like in `accessTokenExpired` /
 *  `refreshTokenDead` — otherwise the written `expiresAt` could not be tested deterministically. */
export async function refreshAccessToken(
  blob: CredentialsBlob, f: typeof fetch, now: number = Date.now(),
): Promise<RefreshResult> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: blob.claudeAiOauth.refreshToken,
    client_id: OAUTH_CLIENT_ID,
  }).toString();

  let res: Response;
  try {
    res = await f(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
  } catch (e) {
    return { ok: false, dead: false, error: (e as Error).message };
  }

  if (!res.ok) {
    const detail = extractErrorDetail(await res.text().catch(() => ""));
    const dead = res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429;
    return { ok: false, dead, error: `HTTP ${res.status}${detail ? ` ${detail}` : ""}` };
  }

  const j = (await res.json().catch(() => null)) as
    { access_token?: string; refresh_token?: string; expires_in?: number; refresh_token_expires_in?: number } | null;
  if (!j || typeof j.access_token !== "string") {
    return { ok: false, dead: false, error: "response without access_token" };
  }

  const expiresIn = typeof j.expires_in === "number" && Number.isFinite(j.expires_in) ? j.expires_in : 8 * 3600;
  const rotated = typeof j.refresh_token === "string";

  // Rotation: the server may return a NEW refresh token. If it were not saved, the profile
  // would silently die after a few refreshes (see spec, Risks 1) — so refreshToken is
  // overwritten whenever the response contains it.
  //
  // ITS expiry rotates too, though — the old refreshTokenExpiresAt belonged to a token that
  // no longer exists. Leaving it in place would mean that refreshTokenDead() would, once
  // ~28 days after the ORIGINAL login, quarantine the account even though every refresh succeeded.
  // We have not verified (without calling the real endpoint, which a test does not do) whether
  // the response carries `refresh_token_expires_in` — if it does, it is used; if not, the field
  // is CLEARED on rotation, so refreshTokenDead() keeps its principle "a missing
  // field does not mean dead, guessing would be worse than not knowing".
  const rotatedExpiresIn = typeof j.refresh_token_expires_in === "number" && Number.isFinite(j.refresh_token_expires_in)
    ? j.refresh_token_expires_in : null;
  const refreshTokenExpiresAt = rotated
    ? (rotatedExpiresIn !== null ? now + rotatedExpiresIn * 1000 : undefined)
    : blob.claudeAiOauth.refreshTokenExpiresAt;

  return {
    ok: true,
    blob: {
      claudeAiOauth: {
        ...blob.claudeAiOauth,
        accessToken: j.access_token,
        refreshToken: rotated ? (j.refresh_token as string) : blob.claudeAiOauth.refreshToken,
        expiresAt: now + expiresIn * 1000,
        refreshTokenExpiresAt,
      },
    },
  };
}
