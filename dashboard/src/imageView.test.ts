import { expect, test } from "bun:test";
import { attachmentUrl, MAX_IMAGE_BYTES, MAX_IMAGE_SIDE, MAX_IMAGES_PER_MESSAGE, planImage, takeImages } from "./imageView";

const MB = 1024 * 1024;

test("a small jpeg is re-encoded once (drops its EXIF, GPS included), then kept", () => {
  expect(planImage({ type: "image/jpeg", bytes: 200_000, width: 1200, height: 800 })).toEqual({ action: "resize", width: 1200, height: 800, type: "image/jpeg" });
  expect(planImage({ type: "image/jpeg", bytes: 200_000, width: 1200, height: 800, encoded: true })).toEqual({ action: "keep" });
  // An encoded result that is still too big is planned again.
  expect(planImage({ type: "image/jpeg", bytes: 6 * MB, width: 2000, height: 1500, encoded: true }).action).toBe("resize");
});

test("a small png, webp or gif is sent as it is", () => {
  for (const type of ["image/png", "image/webp", "image/gif"]) {
    expect(planImage({ type, bytes: 200_000, width: 1200, height: 800 })).toEqual({ action: "keep" });
  }
  expect(planImage({ type: "image/png", bytes: MAX_IMAGE_BYTES, width: MAX_IMAGE_SIDE, height: 10 })).toEqual({ action: "keep" });
});

test("oversized image is downscaled, huge one rejected", () => {
  // Too many pixels: the longest side goes down to 2048, the aspect ratio stays.
  expect(planImage({ type: "image/png", bytes: 1 * MB, width: 3000, height: 1000 })).toEqual({ action: "resize", width: 2048, height: 683, type: "image/png" });
  expect(planImage({ type: "image/jpeg", bytes: 2 * MB, width: 3000, height: 6000 })).toEqual({ action: "resize", width: 1024, height: 2048, type: "image/jpeg" });
  // Too many bytes: shrunk by area well under 4 MB.
  const heavy = planImage({ type: "image/jpeg", bytes: 12 * MB, width: 2000, height: 1500 });
  expect(heavy.action).toBe("resize");
  if (heavy.action !== "resize") throw new Error("unreachable");
  expect(heavy.width).toBeLessThan(2000 * Math.sqrt(4 / 12));
  expect(heavy.height / heavy.width).toBeCloseTo(0.75, 2);
  // webp and gif are re-encoded as png (keeps transparency); jpeg stays jpeg.
  expect(planImage({ type: "image/webp", bytes: 1 * MB, width: 4096, height: 4096 })).toMatchObject({ type: "image/png" });
  expect(planImage({ type: "image/gif", bytes: 5 * MB, width: 800, height: 600 })).toMatchObject({ action: "resize", type: "image/png" });
  // Over 20 MB is never sent.
  const huge = planImage({ type: "image/jpeg", bytes: 21 * MB, width: 8000, height: 6000 });
  expect(huge).toEqual({ action: "reject", message: "The image is 21.0 MB; images over 20 MB cannot be attached" });
});

test("other types are rejected with a message", () => {
  expect(planImage({ type: "image/svg+xml", bytes: 100, width: 10, height: 10 })).toEqual({ action: "reject", message: "Only png, jpeg, webp or gif images can be attached" });
  expect(planImage({ type: "", bytes: 100, width: 10, height: 10 })).toMatchObject({ action: "reject" });
});

test("a resize never ends at zero pixels", () => {
  expect(planImage({ type: "image/png", bytes: 1 * MB, width: 10_000, height: 1 })).toEqual({ action: "resize", width: 2048, height: 1, type: "image/png" });
});

test("at most 10 images per message: the rest are left out with a message", () => {
  expect(MAX_IMAGES_PER_MESSAGE).toBe(10);
  expect(takeImages(0, 3)).toEqual({ take: 3, message: null });
  expect(takeImages(8, 3)).toEqual({ take: 2, message: "At most 10 images per message; 1 was left out" });
  expect(takeImages(10, 2)).toEqual({ take: 0, message: "At most 10 images per message; 2 were left out" });
});

test("attachmentUrl points at the session's thread attachment route", () => {
  expect(attachmentUrl("dev-a chat", "/inbox/dev-a chat/0b4e.png")).toBe("/api/sessions/dev-a%20chat/thread/attachments/0b4e.png");
});
