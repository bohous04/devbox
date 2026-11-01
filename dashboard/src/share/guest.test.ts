import { expect, test } from "bun:test";
import { countdownLabel, previewUrl, shareTokenFromPath, shareWsUrl, untilLabel } from "./guest";

test("token from the path /s/<token>", () => {
  expect(shareTokenFromPath("/s/AbC-_09xyz")).toBe("AbC-_09xyz");
  expect(shareTokenFromPath("/s/AbC-_09xyz/")).toBe("AbC-_09xyz");
  expect(shareTokenFromPath("/s/")).toBeNull();
  expect(shareTokenFromPath("/")).toBeNull();
  expect(shareTokenFromPath("/s/abc/info")).toBeNull();
  expect(shareTokenFromPath("/s/ab%2Fc")).toBeNull();
  expect(shareTokenFromPath("/x/abc")).toBeNull();
});

test("guest WS URL: wss on https, token in the path", () => {
  expect(shareWsUrl("tok", { protocol: "https:", host: "share.example.com" })).toBe("wss://share.example.com/s/tok/ws");
  expect(shareWsUrl("tok", { protocol: "http:", host: "localhost:4302" })).toBe("ws://localhost:4302/s/tok/ws");
});

test("preview: port 3000+N → pN.example.com/s/<token>", () => {
  const loc = { host: "share.example.com" };
  expect(previewUrl("tok", 3000, loc)).toBe("https://p0.example.com/s/tok");
  expect(previewUrl("tok", 3007, loc)).toBe("https://p7.example.com/s/tok");
  expect(previewUrl("tok", 2999, loc)).toBeNull();
  expect(previewUrl("tok", 3010, loc)).toBeNull();
  expect(previewUrl("tok", 3000, { host: "localhost:4302" })).toBeNull();
});

test("countdown: h:mm:ss / m:ss, never negative", () => {
  expect(countdownLabel(0)).toBe("0:00");
  expect(countdownLabel(-5000)).toBe("0:00");
  expect(countdownLabel(65_000)).toBe("1:05");
  expect(countdownLabel(59_999)).toBe("1:00"); // rounds up — 0:00 only after expiry
  expect(countdownLabel(3_600_000 + 2 * 60_000 + 3_000)).toBe("1:02:03");
  expect(countdownLabel(24 * 3_600_000)).toBe("24:00:00");
});

test("valid until HH:MM", () => {
  // `now` explicitly: without it the test only passed on the day it was written.
  const now = new Date(2026, 9, 19, 8, 0).getTime();
  expect(untilLabel(new Date(2026, 9, 19, 9, 4).getTime(), now)).toBe("09:04");
  expect(untilLabel(new Date(2026, 9, 20, 7, 30).getTime(), now)).toBe("10/20 07:30"); // across midnight
});
