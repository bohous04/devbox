import { expect, test, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  sendLiveActivityApns, liveActivityPayload, liveActivityCurlArgs, type LiveActivityPush,
  apnsJwt, apnsPayload, apnsCurlArgs, sendApns, resetApnsJwtCache, resetApnsWarnings,
  type ApnsConfig, type ApnsNotification,
} from "../src/apns";

beforeEach(() => { resetApnsJwtCache(); resetApnsWarnings(); });

function b64urlDecodeToBuffer(s: string): Buffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}
const b64urlDecode = (s: string) => b64urlDecodeToBuffer(s).toString("utf8");

function toPem(der: ArrayBuffer): string {
  const b64 = Buffer.from(der).toString("base64");
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----\n`;
}

// Generates a real P-256 pair, stores the private key as .p8 (exactly the format the
// Apple Developer Portal provides), returns the public one to verify the signature in the test.
async function makeKeyFile(): Promise<{ path: string; publicKey: CryptoKey }> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
  const dir = mkdtempSync(join(tmpdir(), "apns-test-"));
  const path = join(dir, "AuthKey_TEST.p8");
  writeFileSync(path, toPem(pkcs8));
  return { path, publicKey: pair.publicKey };
}

const cfg = (keyPath: string, over: Partial<ApnsConfig> = {}): ApnsConfig => ({
  keyPath, keyId: "KEYID123", teamId: "TEAM123ABC", bundleId: "com.example.app", ...over,
});

const note = (over: Partial<ApnsNotification> = {}): ApnsNotification =>
  ({ title: "Done", message: "Session finished", category: "done", ...over });

test("apnsJwt: header and claims are decodable base64url, signature verifiable against the public key", async () => {
  const { path, publicKey } = await makeKeyFile();
  const nowSec = 1_756_000_000;
  const jwt = await apnsJwt(cfg(path), nowSec);
  const [h, c, s] = jwt.split(".");
  expect(JSON.parse(b64urlDecode(h))).toEqual({ alg: "ES256", kid: "KEYID123" });
  expect(JSON.parse(b64urlDecode(c))).toEqual({ iss: "TEAM123ABC", iat: nowSec });
  const ok = await crypto.subtle.verify(
    // Uint8Array.from(...), not Buffer directly — BufferSource wants Uint8Array<ArrayBuffer>, Buffer is
    // Uint8Array<ArrayBufferLike> (the same trap as in apns.ts pemToDer).
    { name: "ECDSA", hash: "SHA-256" }, publicKey, Uint8Array.from(b64urlDecodeToBuffer(s)), new TextEncoder().encode(`${h}.${c}`),
  );
  expect(ok).toBe(true);
});

test("apnsJwt: cache is valid up to 50 min (same token), from 50 min a new one is minted", async () => {
  const { path } = await makeKeyFile();
  const c = cfg(path);
  const t1 = await apnsJwt(c, 1000);
  const t2 = await apnsJwt(c, 1000 + 49 * 60);
  expect(t2).toBe(t1);
  const t3 = await apnsJwt(c, 1000 + 50 * 60);
  expect(t3).not.toBe(t1);
});

test("apnsPayload: basic shape without time-sensitive and without optional fields", () => {
  expect(apnsPayload(note())).toEqual({
    aps: { alert: { title: "Done", body: "Session finished" }, category: "done", sound: "default", "content-available": 1 },
  });
});

test("apnsPayload: interruption-level is added only with timeSensitive: true, optional fields are passed through", () => {
  const n = note({
    title: "Blocked", message: "Waiting for input", category: "blocked",
    timeSensitive: true, sessionId: "s1", alertId: "a1", terminal: true,
  });
  expect(apnsPayload(n)).toEqual({
    aps: {
      alert: { title: "Blocked", body: "Waiting for input" }, category: "blocked", sound: "default",
      "interruption-level": "time-sensitive", "content-available": 1,
    },
    sessionId: "s1", alertId: "a1", terminal: true,
  });
});

test("apnsPayload: timeSensitive: false does not add interruption-level", () => {
  const payload = apnsPayload(note({ timeSensitive: false })) as { aps: Record<string, unknown> };
  expect(payload.aps["interruption-level"]).toBeUndefined();
});

test("apnsCurlArgs: argv for the production endpoint (without the curl binary at the start)", () => {
  const c = cfg("x");
  const payload = { aps: { alert: { title: "a", body: "b" }, category: "done", sound: "default" } };
  const args = apnsCurlArgs(c, "jwt-token", "devicetoken123", payload);
  expect(args).toEqual([
    "-s", "-g", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "10", "--http2-prior-knowledge",
    "-H", "authorization: bearer jwt-token",
    "-H", "apns-topic: com.example.app",
    "-H", "apns-push-type: alert",
    "-d", JSON.stringify(payload),
    "https://api.push.apple.com/3/device/devicetoken123",
  ]);
});

test("apnsCurlArgs: sandbox: true switches the host to api.sandbox.push.apple.com", () => {
  const args = apnsCurlArgs(cfg("x", { sandbox: true }), "jwt", "tok", {});
  expect(args.at(-1)).toBe("https://api.sandbox.push.apple.com/3/device/tok");
});

test("sendApns: HTTP 200 → ok", async () => {
  const { path } = await makeKeyFile();
  const r = await sendApns(
    { run: async () => ({ code: 0, stdout: "200", stderr: "" }), now: () => 1_756_000_000_000 },
    cfg(path), "tok", note(),
  );
  expect(r).toBe("ok");
});

test("sendApns: HTTP 410 → gone (the caller deletes the token)", async () => {
  const { path } = await makeKeyFile();
  const r = await sendApns(
    { run: async () => ({ code: 0, stdout: "410", stderr: "" }), now: () => 1_756_000_000_000 },
    cfg(path), "tok", note(),
  );
  expect(r).toBe("gone");
});

test("sendApns: another HTTP code → error", async () => {
  const { path } = await makeKeyFile();
  const r = await sendApns(
    { run: async () => ({ code: 0, stdout: "500", stderr: "" }), now: () => 1_756_000_000_000 },
    cfg(path), "tok", note(),
  );
  expect(r).toBe("error");
});

test("sendApns: curl process fails (exit 6) → error", async () => {
  const { path } = await makeKeyFile();
  const r = await sendApns(
    { run: async () => ({ code: 6, stdout: "", stderr: "Could not resolve host" }), now: () => 1_756_000_000_000 },
    cfg(path), "tok", note(),
  );
  expect(r).toBe("error");
});

test("sendApns: missing/unreadable key → error, the warning is printed only once", async () => {
  const seen: string[] = [];
  const orig = console.warn;
  console.warn = (m: string) => { seen.push(m); };
  try {
    const badCfg = cfg("/nonexistent/path/AuthKey_MISSING.p8");
    const run = async () => ({ code: 0, stdout: "200", stderr: "" });
    const r1 = await sendApns({ run, now: () => 1 }, badCfg, "tok", note());
    const r2 = await sendApns({ run, now: () => 2 }, badCfg, "tok", note());
    expect(r1).toBe("error");
    expect(r2).toBe("error");
    expect(seen).toHaveLength(1);
  } finally {
    console.warn = orig;
  }
});


test("Live Activity transport classifies expiration, rejection and temporary errors without credential leakage", async () => {
  const { path } = await makeKeyFile();
  const push = { event: "update" as const, timestamp: 1_700_000_000, contentState: { version: 1 }, staleDate: 1_700_000_090 };
  for (const [stdout,expected] of [
    ["\n200","ok"], ['{"reason":"Unregistered"}\n410',"gone"],
    ['{"reason":"BadDeviceToken"}\n400',"gone"], ['{"reason":"DeviceTokenNotForTopic"}\n400',"gone"],
    ['{"reason":"BadPayload"}\n400',"error"], ['{"reason":"TooManyRequests"}\n429',"retry"],
    ['{"reason":"ServiceUnavailable"}\n503',"retry"],
  ] as const) {
    const result = await sendLiveActivityApns({now:()=>1_700_000_000_000,run:async args => {
      expect(args).toContain("apns-push-type: liveactivity");
      expect(args).toContain("apns-topic: com.example.app.push-type.liveactivity");
      return {code:0,stdout,stderr:""};
    }},cfg(path),"a".repeat(64),push);
    expect(result).toBe(expected);
  }
  expect(liveActivityPayload({...push,event:"end",dismissalDate:1_700_000_120}).aps["dismissal-date"]).toBe(1_700_000_120);
  expect(liveActivityPayload(push).aps).not.toHaveProperty("attributes-type");
});

test("Live Activity apns-priority: 10 for start/end and urgent update, 5 otherwise", () => {
  const CFG: ApnsConfig = { keyPath: "/never-read", keyId: "k", teamId: "t", bundleId: "com.example.devbox" };
  const prio = (push: LiveActivityPush) => liveActivityCurlArgs(CFG, "jwt", "ab".repeat(32), push).find(a => a.startsWith("apns-priority:"));
  const p = { timestamp: 1, contentState: {} };
  expect(prio({ ...p, event: "update" })).toBe("apns-priority: 5");
  expect(prio({ ...p, event: "update", priority: 5 })).toBe("apns-priority: 5");
  expect(prio({ ...p, event: "update", priority: 10 })).toBe("apns-priority: 10");
  expect(prio({ ...p, event: "start" })).toBe("apns-priority: 10");
  expect(prio({ ...p, event: "end", priority: 5 })).toBe("apns-priority: 10");
});

test("apnsPayload: the tap target goes top-level as target/targetId", () => {
  expect(apnsPayload(note({ category: "blocked", target: "prodWrites", targetId: "42" }))).toMatchObject({ target: "prodWrites", targetId: "42" });
  const noId = apnsPayload(note({ target: "vault" })) as Record<string, unknown>;
  expect(noId.target).toBe("vault");
  expect("targetId" in noId).toBe(false);
});
