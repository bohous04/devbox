// Text limits for Live Activity pushes. APNs counts payload size in UTF-8 bytes, so the
// limits here are bytes, not characters.

const ELLIPSIS = "…";
const ELLIPSIS_BYTES = Buffer.byteLength(ELLIPSIS, "utf8");

/** Flatten control characters to spaces, trim, and shorten to at most `maxBytes` UTF-8
 *  bytes without cutting a code point. A shortened result ends with an ellipsis, which
 *  counts toward the budget. */
export function clipToBytes(text: string, maxBytes: number): string {
  const flat = text.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (Buffer.byteLength(flat, "utf8") <= maxBytes) return flat;
  const room = maxBytes - ELLIPSIS_BYTES;
  let used = 0;
  let end = 0;
  for (const codePoint of flat) {
    const size = Buffer.byteLength(codePoint, "utf8");
    if (used + size > room) break;
    used += size;
    end += codePoint.length;
  }
  return flat.slice(0, end).trimEnd() + ELLIPSIS;
}
