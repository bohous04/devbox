/** Chat images: what the composer sends (devd stores png, jpeg, webp and gif up to its 25 MB upload limit). */
export const MAX_IMAGE_SIDE = 2048;
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_INPUT_BYTES = 20 * 1024 * 1024;
/** devd refuses more (threadApi.ts MAX_IMAGES_PER_MESSAGE). */
export const MAX_IMAGES_PER_MESSAGE = 10;
const TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export type ImagePlan =
  | { action: "keep" }
  | { action: "resize"; width: number; height: number; type: "image/png" | "image/jpeg" }
  | { action: "reject"; message: string };

/** What to do with an image before it is sent: as it is when it is at most 2048 px on its longest side and 4 MB,
 *  over 20 MB never, else scaled down (by side, and by area when it is too heavy). A jpeg stays a jpeg; the others
 *  become png, which keeps transparency (a gif keeps only its first frame). A jpeg not `encoded` by us yet is
 *  re-encoded at its size even when it fits: that drops its EXIF (GPS position included). Pure: the caller re-plans
 *  the result with `encoded: true`. */
export function planImage(img: { type: string; bytes: number; width: number; height: number; encoded?: boolean }): ImagePlan {
  if (!TYPES.has(img.type)) return { action: "reject", message: "Only png, jpeg, webp or gif images can be attached" };
  if (img.bytes > MAX_INPUT_BYTES) {
    return { action: "reject", message: `The image is ${(img.bytes / 1024 / 1024).toFixed(1)} MB; images over 20 MB cannot be attached` };
  }
  const longest = Math.max(img.width, img.height);
  if (longest <= MAX_IMAGE_SIDE && img.bytes <= MAX_IMAGE_BYTES) {
    return img.type === "image/jpeg" && !img.encoded ? { action: "resize", width: img.width, height: img.height, type: "image/jpeg" } : { action: "keep" };
  }
  let scale = Math.min(1, MAX_IMAGE_SIDE / longest);
  // Bytes grow roughly with the area; 0.9 leaves room for the encoder, so one more round is rarely needed.
  if (img.bytes > MAX_IMAGE_BYTES) scale = Math.min(scale, Math.sqrt(MAX_IMAGE_BYTES / img.bytes) * 0.9);
  return {
    action: "resize",
    width: Math.max(1, Math.round(img.width * scale)),
    height: Math.max(1, Math.round(img.height * scale)),
    type: img.type === "image/jpeg" ? "image/jpeg" : "image/png",
  };
}

/** How many of `adding` images fit next to the `attached` ones, and what to tell the user about the rest. */
export function takeImages(attached: number, adding: number): { take: number; message: string | null } {
  const take = Math.max(0, Math.min(adding, MAX_IMAGES_PER_MESSAGE - attached));
  const left = adding - take;
  return { take, message: left === 0 ? null : `At most ${MAX_IMAGES_PER_MESSAGE} images per message; ${left} ${left === 1 ? "was" : "were"} left out` };
}

/** Where the dashboard loads a thread image (devd/src/threadApi.ts) from its container path `/inbox/<id>/<name>`. */
export function attachmentUrl(sessionId: string, path: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/thread/attachments/${encodeURIComponent(path.slice(path.lastIndexOf("/") + 1))}`;
}

/** Browser side of planImage: decodes, scales on a canvas and re-plans until the image fits. Throws with the
 *  user-facing message when it cannot be sent. */
export async function prepareImage(file: Blob): Promise<Blob> {
  let blob = file;
  // Each round shrinks by area; a few are plenty, more means the encoder does not get under 4 MB.
  for (let round = 0; ; round++) {
    const bitmap = await createImageBitmap(blob).catch(() => { throw new Error("The image could not be read"); });
    const plan = planImage({ type: blob.type, bytes: blob.size, width: bitmap.width, height: bitmap.height, encoded: round > 0 });
    if (plan.action !== "resize") bitmap.close();
    if (plan.action === "reject") throw new Error(plan.message);
    if (plan.action === "keep") return blob;
    if (round === 3) { bitmap.close(); throw new Error("The image could not be scaled down under 4 MB"); }
    const canvas = document.createElement("canvas");
    canvas.width = plan.width;
    canvas.height = plan.height;
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, plan.width, plan.height);
    bitmap.close();
    blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("The image could not be scaled down"))), plan.type, 0.85));
  }
}
