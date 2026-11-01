// APNs (Apple Push Notification service) sender — JWT ES256 provider auth (Apple's
// "token-based" scheme, not a certificate) + payload sending.
//
// WHY curl instead of Bun fetch: the APNs HTTP/2 API requires requests over HTTP/2, but Bun
// fetch cannot force HTTP/2 without ALPN negotiation (and the server may not negotiate it
// with APNs as reliably as curl). `curl --http2-prior-knowledge` forces HTTP/2
// directly. The call goes through an injected `run` — same pattern as docker
// in agentAuth.ts/codexPoller.ts (testable without network, does not block the devd event
// loop). `apnsCurlArgs` returns only argv WITHOUT the "curl" binary at the start — that
// (just like "docker" for the other `run` implementations in index.ts) is added by
// the injected `run` function itself.
//
// JWT signature: Apple requires ES256 (ECDSA over P-256 + SHA-256) over
// `<header>.<claims>` in base64url. WebCrypto `sign({name:"ECDSA",hash:"SHA-256"})`
// returns raw r||s (64 bytes) directly, not ASN.1 DER — and that is exactly the format
// ES256 JWT expects, so no further conversion is needed.

export interface ApnsConfig {
  keyPath: string;
  keyId: string;
  teamId: string;
  bundleId: string;
  sandbox?: boolean;
}

export interface ApnsNotification {
  title: string;
  message: string;
  category: "done" | "blocked" | "emergency";
  sessionId?: string;
  alertId?: string;
  terminal?: boolean;
  timeSensitive?: boolean;
  /** App screen after tapping, when the notification does not belong to a session (see NotifyTarget). */
  target?: string;
  targetId?: string;
}

type RunFn = (cmd: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
export interface ApnsSendDeps { run: RunFn; now: () => number }

function base64url(bytes: Uint8Array | string): string {
  const buf = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : Buffer.from(bytes);
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The `.p8` key from the Apple Developer Portal is PEM (PKCS#8) — WebCrypto `importKey("pkcs8", …)`
 *  however wants raw DER, not text with BEGIN/END lines. */
// The return type MUST be `Uint8Array<ArrayBuffer>`, not bare `Uint8Array` (in this project with
// bun-types a bare `Uint8Array` behaves as `Uint8Array<ArrayBufferLike>` — and WebCrypto
// `BufferSource` (importKey/sign/verify) rejects that, because `ArrayBufferLike` also covers
// `SharedArrayBuffer`). `Buffer` is also just `Uint8Array<ArrayBufferLike>`, hence the copy into a
// freshly allocated `new Uint8Array(length)`, not direct wrapping/`.from(buffer)`.
function pemToDer(pem: string): Uint8Array<ArrayBuffer> {
  const b64 = pem.replace(/-----BEGIN [^-]+-----/, "").replace(/-----END [^-]+-----/, "").replace(/\s+/g, "");
  const buf = Buffer.from(b64, "base64");
  const der = new Uint8Array(buf.byteLength);
  der.set(buf);
  return der;
}

// Apple accepts tokens at most 60 minutes old; 50 minutes is a margin against edge
// cases (devd clock vs. Apple, request transfer time).
const JWT_TTL_SEC = 50 * 60;
const jwtCache = new Map<string, { token: string; mintedAt: number }>();

/** Tests need to reset the cache between cases, otherwise test order would affect
 *  whether the token is minted again — same pattern as `resetPricingWarnings` in pricing.ts. */
export function resetApnsJwtCache(): void { jwtCache.clear(); }

const warnedKeyPaths = new Set<string>();
/** A missing/unreadable key is logged only once per path — same pattern as
 *  `warnUnpricedModel` in pricing.ts (dedupe via a Set, no spam on every push). */
function warnKeyUnreadable(keyPath: string, err: unknown): void {
  if (warnedKeyPaths.has(keyPath)) return;
  warnedKeyPaths.add(keyPath);
  console.warn(`apns: key "${keyPath}" cannot be read — push will not be sent (${String(err)})`);
}
export function resetApnsWarnings(): void { warnedKeyPaths.clear(); }

/** ES256 JWT for APNs provider auth (`Authorization: bearer <jwt>`). Cached
 *  by (teamId, keyId) — that is the only thing the token identifies by its content. */
export async function apnsJwt(cfg: ApnsConfig, nowSec: number): Promise<string> {
  const cacheKey = `${cfg.teamId}:${cfg.keyId}`;
  const cached = jwtCache.get(cacheKey);
  if (cached && nowSec - cached.mintedAt < JWT_TTL_SEC) return cached.token;

  const pem = await Bun.file(cfg.keyPath).text(); // throws when the file is missing/unreadable
  const key = await crypto.subtle.importKey("pkcs8", pemToDer(pem), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const header = base64url(JSON.stringify({ alg: "ES256", kid: cfg.keyId }));
  const claims = base64url(JSON.stringify({ iss: cfg.teamId, iat: nowSec }));
  const signingInput = `${header}.${claims}`;
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(signingInput));
  const token = `${signingInput}.${base64url(new Uint8Array(sig))}`;
  jwtCache.set(cacheKey, { token, mintedAt: nowSec });
  return token;
}

export function apnsPayload(n: ApnsNotification): object {
  // Alert delivery informs the user; content-available also gives the iOS app a short
  // background window to end/update the corresponding Live Activity.
  const aps: Record<string, unknown> = {
    alert: { title: n.title, body: n.message }, category: n.category, sound: "default",
    "content-available": 1,
  };
  if (n.timeSensitive) aps["interruption-level"] = "time-sensitive";
  const payload: Record<string, unknown> = { aps };
  if (n.sessionId !== undefined) payload.sessionId = n.sessionId;
  if (n.alertId !== undefined) payload.alertId = n.alertId;
  if (n.terminal !== undefined) payload.terminal = n.terminal;
  if (n.target !== undefined) payload.target = n.target;
  if (n.targetId !== undefined) payload.targetId = n.targetId;
  return payload;
}

export function apnsCurlArgs(cfg: ApnsConfig, jwt: string, deviceToken: string, payload: object): string[] {
  const host = cfg.sandbox ? "api.sandbox.push.apple.com" : "api.push.apple.com";
  return [
    // `-g` (globoff): deviceToken goes directly into the URL and without it curl reads {}/[] as a
    // glob pattern — a foreign/corrupt token would then fail with "bad range" instead of a 410
    // from Apple. `--max-time 10`: a hanging request (dead network, APNs not responding) must not
    // hold the queue forever — without a limit the emergency queue tick (30 s) would overtake
    // its own run and alerts would be sent several times at once.
    "-s", "-g", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "10", "--http2-prior-knowledge",
    "-H", `authorization: bearer ${jwt}`,
    "-H", `apns-topic: ${cfg.bundleId}`,
    "-H", "apns-push-type: alert",
    "-d", JSON.stringify(payload),
    `https://${host}/3/device/${deviceToken}`,
  ];
}

/** `-w "%{http_code}"` + `-o /dev/null` → stdout is purely the status code. 410 = token
 *  invalid (the caller must delete it from the DB), anything else (another code or curl
 *  itself failed) is an undifferentiated error — the caller retries the push later. */
export async function sendApns(d: ApnsSendDeps, cfg: ApnsConfig, deviceToken: string, n: ApnsNotification): Promise<"ok" | "gone" | "error"> {
  let jwt: string;
  try {
    jwt = await apnsJwt(cfg, Math.floor(d.now() / 1000));
  } catch (err) {
    warnKeyUnreadable(cfg.keyPath, err);
    return "error";
  }
  const r = await d.run(apnsCurlArgs(cfg, jwt, deviceToken, apnsPayload(n)));
  if (r.code !== 0) return "error";
  const status = r.stdout.trim();
  if (status === "200") return "ok";
  if (status === "410") return "gone";
  return "error";
}

export interface LiveActivityPush {
  event: "start" | "update" | "end";
  timestamp: number;
  contentState: object;
  serverID?: string;
  staleDate?: number;
  dismissalDate?: number;
  /** Update only: 10 = the set of waiting/stalled changed (see needsHighPriority). Start/end are always 10. */
  priority?: 5 | 10;
}

export function liveActivityPayload(n: LiveActivityPush): { aps: Record<string, unknown> } {
  const aps: Record<string, unknown> = {
    timestamp: n.timestamp, event: n.event, "content-state": n.contentState,
  };
  if (n.staleDate !== undefined) aps["stale-date"] = n.staleDate;
  if (n.event === "start") {
    aps["attributes-type"] = "DevboxAgentActivityAttributes";
    aps.attributes = { serverID: n.serverID };
    // iOS 18+ requests the update token for push-to-start activities.
    aps["input-push-token"] = 1;
    aps.alert = { title: "Devbox", body: "Agent started working" };
  }
  if (n.event === "end") aps["dismissal-date"] = n.dismissalDate ?? n.timestamp;
  return { aps };
}

export function liveActivityCurlArgs(cfg: ApnsConfig, jwt: string, token: string, n: LiveActivityPush): string[] {
  const payload = JSON.stringify(liveActivityPayload(n));
  if (Buffer.byteLength(payload, "utf8") > 4096) throw new Error("Live Activity payload exceeds APNs limit");
  const host = cfg.sandbox ? "api.sandbox.push.apple.com" : "api.push.apple.com";
  return ["-s", "-g", "-w", "\n%{http_code}", "--max-time", "10", "--http2-prior-knowledge",
    "-H", `authorization: bearer ${jwt}`,
    "-H", `apns-topic: ${cfg.bundleId}.push-type.liveactivity`,
    "-H", "apns-push-type: liveactivity",
    "-H", `apns-priority: ${n.event === "update" ? (n.priority ?? 5) : 10}`,
    "-H", `apns-expiration: ${n.timestamp + 90}`,
    "-d", payload, `https://${host}/3/device/${token}`];
}

/** Result categories are deliberately token-free; never log raw curl args/body. */
export async function sendLiveActivityApns(d: ApnsSendDeps, cfg: ApnsConfig, token: string, n: LiveActivityPush): Promise<"ok" | "gone" | "retry" | "error"> {
  try {
    const jwt = await apnsJwt(cfg, Math.floor(d.now() / 1000));
    const r = await d.run(liveActivityCurlArgs(cfg, jwt, token, n));
    if (r.code !== 0) return "error";
    const lines = r.stdout.trim().split("\n");
    const status = Number(lines.pop());
    if (status === 200) return "ok";
    let reason = "";
    try { reason = JSON.parse(lines.join("\n")).reason ?? ""; } catch { /* no response body */ }
    if (status === 410 || (status === 400 && ["BadDeviceToken", "DeviceTokenNotForTopic", "ExpiredToken"].includes(reason))) return "gone";
    if (status === 429 || status >= 500) return "retry";
    return "error";
  } catch { return "error"; }
}
