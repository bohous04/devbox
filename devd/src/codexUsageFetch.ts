// Reading the Codex quota from the network. Separated from parsing (codexUsage.ts) so that
// parsing can be tested without the network — and because this is the part that breaks
// when OpenAI moves the path.

import { parseCodexUsage, type CodexUsage } from "./codexUsage";

/** Version for the User-Agent. Not for cosmetics: without the headers the Codex CLI sends,
 *  chatgpt.com returns an HTML bot-check instead of JSON (verified live 2026-08-20). */
export const CODEX_UA_VERSION = "0.148.0";

/** The usage path is NOT certain — both are read out of the binary. Measured state
 *  2026-08-20: #0 returns 403 with HTML, #2 returns 402 with JSON `deactivated_workspace`
 *  (so the path is alive and the headers fit, only that workspace is deactivated). */
export const USAGE_CANDIDATES = [
  { method: "GET", url: "https://chatgpt.com/backend-api/codex/usage" },
  { method: "POST", url: "https://chatgpt.com/backend-api/codex/usage" },
  { method: "POST", url: "https://chatgpt.com/backend-api/codex/usage/thread_usage/query" },
] as const satisfies readonly { method: "GET" | "POST"; url: string }[];

export interface CodexAuthTokens {
  accessToken: string;
  accountId: string | null;
  idToken: string | null;
  lastRefresh: string | null;
}

export type CodexFetchResult =
  | { ok: true; usage: CodexUsage; endpointIdx: number }
  | { ok: false; error: string };

/** `null` = auth.json is missing, is not JSON, or has no access token. In all three
 *  cases it cannot be used to call, and the state is "signed out". */
export function parseCodexAuthJson(raw: string): CodexAuthTokens | null {
  let j: unknown;
  try { j = JSON.parse(raw); } catch { return null; }
  const root = j as { tokens?: Record<string, unknown>; last_refresh?: unknown } | null;
  const t = root?.tokens;
  if (!t || typeof t.access_token !== "string" || t.access_token === "") return null;
  return {
    accessToken: t.access_token,
    accountId: typeof t.account_id === "string" ? t.account_id : null,
    idToken: typeof t.id_token === "string" ? t.id_token : null,
    lastRefresh: typeof root?.last_refresh === "string" ? root.last_refresh : null,
  };
}

export function usageHeaders(t: CodexAuthTokens): Record<string, string> {
  return {
    Authorization: `Bearer ${t.accessToken}`,
    "chatgpt-account-id": t.accountId ?? "",
    "OpenAI-Beta": "responses=experimental",
    originator: "codex_cli_rs",
    version: CODEX_UA_VERSION,
    "User-Agent": `codex_cli_rs/${CODEX_UA_VERSION} (devd)`,
    Accept: "application/json",
  };
}

const isJson = (r: Response): boolean => (r.headers.get("content-type") ?? "").includes("application/json");

/** Error code from the body, when the API sends one (`{"detail":{"code":"…"}}`). */
function errorCode(body: unknown): string | null {
  const d = (body as { detail?: unknown } | null)?.detail;
  if (typeof d === "string") return d;
  const code = (d as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : null;
}

/** `startIdx` is the index that worked last time — the next poll STARTS right there, rather
 *  than trying EXCLUSIVELY that one. The rest of the list follows in its order —
 *  without the tail, a path move on the OpenAI side would poison the remembered index forever
 *  (I2): a single poll to the old path after the move would write an error, `endpoint_idx` would
 *  be kept and every further poll would keep trying only that one dead path. */
export async function fetchCodexUsage(
  t: CodexAuthTokens, f: typeof fetch, startIdx?: number | null,
): Promise<CodexFetchResult> {
  const all = USAGE_CANDIDATES.map((_, i) => i);
  const order = typeof startIdx === "number" && USAGE_CANDIDATES[startIdx] !== undefined
    ? [startIdx, ...all.filter((i) => i !== startIdx)]
    : all;

  const misses: string[] = [];
  for (const i of order) {
    const c = USAGE_CANDIDATES[i];
    let res: Response;
    try {
      res = await f(c.url, { method: c.method, headers: usageHeaders(t), signal: AbortSignal.timeout(10_000) });
    } catch (e) {
      // A failed attempt is LOGGED, not swallowed — without it we would not notice the API moved.
      console.warn(`codex usage #${i} (${c.method} ${c.url}): ${(e as Error).message}`);
      misses.push(`#${i} ${(e as Error).message}`);
      continue;
    }
    if (!isJson(res)) {
      // A failed attempt is LOGGED, not swallowed — without it we would not notice the API moved.
      console.warn(`codex usage #${i} (${c.method} ${c.url}): HTTP ${res.status}, not JSON`);
      misses.push(`#${i} HTTP ${res.status}`);
      continue;
    }
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      // 404 = moved path — exactly the situation the candidate list must survive,
      // so try further. 402/403 are authorization errors: another path will not fix them, return right away.
      if (res.status === 404) {
        console.warn(`codex usage #${i} (${c.method} ${c.url}): HTTP 404, trying the next one`);
        misses.push(`#${i} HTTP 404`);
        continue;
      }
      const code = errorCode(body);
      // A stored data field, not an API-layer message — it ends up in the English card
      // (subscriptionsView.ts), hence in English.
      return { ok: false, error: `${code ?? "error"} (HTTP ${res.status})` };
    }
    const usage = parseCodexUsage(body);
    if (!usage) {
      // Raw response to the log: without it a new shape can only be tuned by guessing.
      console.warn(`codex usage #${i}: unknown response shape:`, JSON.stringify(body).slice(0, 1000));
      return { ok: false, error: "unknown-shape" };
    }
    return { ok: true, usage, endpointIdx: i };
  }
  // A stored data field, not an API-layer message — it ends up in the English card
  // (subscriptionsView.ts), hence in English.
  return { ok: false, error: `no endpoint returned JSON (${misses.join(", ")})` };
}
