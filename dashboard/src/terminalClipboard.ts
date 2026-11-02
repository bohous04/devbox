export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export function validateFiles(files: readonly File[]): void {
  if (files.length > 20) throw new Error("Choose at most 20 files at a time.");
  for (const file of files) {
    if (!file.size) throw new Error(`${file.name}: the file is empty.`);
    if (file.size > MAX_UPLOAD_BYTES) throw new Error(`${file.name}: the upload limit is 25 MB per file.`);
  }
}

export async function uploadFile(id: string, file: File): Promise<string> {
  validateFiles([file]);
  const r = await fetch(`/api/sessions/${encodeURIComponent(id)}/inbox?name=${encodeURIComponent(file.name)}`, {
    method: "POST", headers: { "content-type": "application/octet-stream" }, body: file,
  });
  const body = await r.json().catch(() => ({})) as { error?: string; path?: string };
  if (!r.ok) throw new Error(body.error ?? `Upload failed (HTTP ${r.status}).`);
  // Only the server's sanitized inbox path is ever inserted into the terminal.
  if (!body.path || !/^\/inbox\/[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(body.path)) throw new Error("Invalid upload response.");
  return body.path;
}

export interface BrowserClipboard { files: File[]; text: string }
export async function readBrowserClipboard(clipboard: Pick<Clipboard, "read" | "readText">): Promise<BrowserClipboard> {
  if (!clipboard) throw new Error("Clipboard buttons need HTTPS. Use Ctrl+V / Cmd+V or Upload files instead.");
  if (typeof clipboard.read !== "function") return { files: [], text: await clipboard.readText() };
  const items = await clipboard.read();
  const files: File[] = [];
  let text = "";
  for (const item of items) {
    // Images/files take precedence over an HTML/text representation of the same item.
    const type = item.types.find((t) => t.startsWith("image/")) ?? item.types.find((t) => !t.startsWith("text/"));
    if (type) {
      const blob = await item.getType(type);
      const ext = type === "image/png" ? "png" : type === "image/jpeg" ? "jpg" : "bin";
      files.push(new File([blob], `clipboard-${Date.now()}-${files.length}.${ext}`, { type }));
    } else if (item.types.includes("text/plain")) {
      text += await (await item.getType("text/plain")).text();
    }
  }
  return { files, text };
}

export const MAX_OSC52_BASE64 = 1_400_000;

/** Parses the OSC 52 data part (`<selection>;<base64>`). Returns the text, or null for a query
 *  (`?`, never answered — the page must not leak the clipboard to the session), a clear (empty
 *  payload), invalid base64/UTF-8 or an oversized payload. */
export function decodeOsc52(data: string): string | null {
  const semi = data.indexOf(";");
  if (semi < 0) return null;
  const b64 = data.slice(semi + 1).trim();
  if (!b64 || b64 === "?" || b64.length > MAX_OSC52_BASE64) return null;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) return null;
  try {
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

// The HTTP tailnet dashboard cannot use the secure-context Clipboard API.
export async function writeClipboard(text: string, doc: Document = document): Promise<boolean> {
  const nav = doc.defaultView?.navigator;
  if (doc.defaultView?.isSecureContext && nav?.clipboard?.writeText) {
    try { await nav.clipboard.writeText(text); return true; } catch { /* fall through */ }
  }
  const active = doc.activeElement as HTMLElement | null;
  const ta = doc.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  ta.style.pointerEvents = "none";
  doc.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = doc.execCommand("copy"); } catch { ok = false; }
  ta.remove();
  active?.focus?.();
  return ok;
}

// Let the browser dispatch a real paste event instead of sending ^V into tmux's
// desktop-listener binding. Applies to Windows/Linux and browser Cmd+V on macOS.
export function isPasteShortcut(event: Pick<KeyboardEvent, "type" | "key" | "ctrlKey" | "metaKey" | "altKey">): boolean {
  return event.type === "keydown" && !event.altKey && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v";
}
