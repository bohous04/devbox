import { useEffect, useRef, useState, type RefObject } from "react";
import type { Terminal } from "@xterm/xterm";
import { Button } from "./ui/button";
import { readBrowserClipboard, uploadFile, validateFiles, writeClipboard } from "../terminalClipboard";

const CONTROL_CLASS = "min-h-11 border-[#26303f] bg-[#1c2230] text-[#e6edf3] hover:bg-[#26303f] hover:text-white";

interface Props {
  id?: string;
  host: RefObject<HTMLDivElement | null>;
  terminal: RefObject<Terminal | null>;
  canPaste: boolean;
  offeredText?: string | null;
  onDismiss: () => void;
}

export function TerminalClipboard({ id, host, terminal, canPaste, offeredText, onDismiss }: Props) {
  const [message, setMessage] = useState("");
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteDraft, setPasteDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement | null>(null);
  const locked = useRef(false);
  const active = useRef({ id, canPaste });
  active.current = { id, canPaste };

  function pasteText(text: string) {
    if (!active.current.canPaste) throw new Error("Take control of the terminal before pasting.");
    // xterm respects the application's bracketed-paste mode, so pasted newlines are
    // not sent as individual Enter keys. Never permit an embedded paste terminator.
    terminal.current?.paste(text.replace(/\x1b\[20[01]~/g, ""));
    terminal.current?.focus();
  }

  async function pasteFiles(files: File[]) {
    if (!files.length) return;
    if (!active.current.canPaste || !active.current.id) { setMessage("Take control of the session before uploading."); return; }
    if (locked.current) { setMessage("Wait for the current upload to finish."); return; }
    locked.current = true; setBusy(true);
    const paths: string[] = [];
    const target = active.current.id;
    try {
      validateFiles(files);
      for (const file of files) {
        if (active.current.id !== target || !active.current.canPaste) throw new Error("Upload stopped because the terminal changed.");
        setMessage(`Uploading ${file.name}…`);
        paths.push(await uploadFile(target, file));
      }
      if (active.current.id !== target || !active.current.canPaste) throw new Error("Files uploaded, but the terminal changed. Open the session again to paste their paths.");
      pasteText(paths.join(" "));
      setMessage(`${paths.length} file${paths.length === 1 ? "" : "s"} uploaded: ${paths.join(", ")}`);
    } catch (e) {
      setMessage(`${(e as Error).message}${paths.length ? ` Uploaded: ${paths.join(", ")}` : ""}`);
    } finally { locked.current = false; setBusy(false); }
  }

  async function copy() {
    const text = terminal.current?.getSelection();
    if (!text) { setMessage("Select terminal text first (hold Shift while dragging if the app captures the mouse)."); return; }
    try { if (!await writeClipboard(text)) throw new Error("Clipboard blocked"); setMessage("Copied."); }
    catch { setMessage("Clipboard unavailable. Open over HTTPS or use your browser's Copy command with text selected."); }
  }

  async function paste() {
    if (!canPaste) return;
    try {
      const content = await readBrowserClipboard(navigator.clipboard);
      if (content.files.length) await pasteFiles(content.files);
      else if (content.text) { pasteText(content.text); setMessage("Pasted."); }
      else setMessage("The clipboard is empty. For files copied in Explorer, press Ctrl+V here or use Upload files.");
    } catch { setPasteOpen(true); setMessage("Paste text, a screenshot or a file in the box below using Ctrl+V / Cmd+V."); }
  }

  useEffect(() => {
    active.current = { id, canPaste };
    const element = host.current;
    if (!element) return;
    const onPaste = (event: ClipboardEvent) => {
      event.preventDefault(); event.stopImmediatePropagation();
      if (!active.current.canPaste) { setMessage("Take control of the terminal before pasting."); return; }
      const files = Array.from(event.clipboardData?.files ?? []);
      if (files.length) { void pasteFiles(files); return; }
      try { pasteText(event.clipboardData?.getData("text/plain") ?? ""); }
      catch (e) { setMessage((e as Error).message); }
    };
    const onDragOver = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes("Files")) return;
      event.preventDefault(); event.dataTransfer.dropEffect = active.current.canPaste ? "copy" : "none";
    };
    const onDrop = (event: DragEvent) => {
      if (!event.dataTransfer?.files.length) return;
      event.preventDefault(); event.stopImmediatePropagation();
      void pasteFiles(Array.from(event.dataTransfer.files));
    };
    element.addEventListener("paste", onPaste, true);
    element.addEventListener("dragover", onDragOver);
    element.addEventListener("drop", onDrop, true);
    return () => {
      active.current = { id: undefined, canPaste: false };
      element.removeEventListener("paste", onPaste, true);
      element.removeEventListener("dragover", onDragOver);
      element.removeEventListener("drop", onDrop, true);
    };
  }, [host, terminal]);

  return <div className="border-b border-[#1c2230] px-3 py-2 text-[#e6edf3]">
    <div className="flex flex-wrap items-center gap-2">
      <Button className={CONTROL_CLASS} variant="outline" size="sm" onClick={copy}>Copy selection</Button>
      <Button className={CONTROL_CLASS} variant="outline" size="sm" onClick={paste} disabled={!canPaste || busy}>Paste</Button>
      {id && <Button className={CONTROL_CLASS} variant="outline" size="sm" onClick={() => input.current?.click()} disabled={!canPaste || busy}>{busy ? "Uploading…" : "Upload files"}</Button>}
      <input ref={input} type="file" multiple hidden aria-label="Upload files to the session" onChange={(event) => {
        void pasteFiles(Array.from(event.target.files ?? [])); event.target.value = "";
      }} />
      <span className="text-xs text-[#9fb0c3]">Ctrl+V / Cmd+V: text, screenshots or files · Drop files here · Shared /inbox · 25 MB per file</span>
    </div>
    {pasteOpen && <div className="flex flex-wrap items-center gap-2 pt-2">
      <textarea autoFocus aria-label="Paste text, image or file" rows={2} className="min-w-0 flex-1 rounded border border-[#26303f] bg-[#0b0e14] p-2 text-base"
        placeholder="Paste here with Ctrl+V / Cmd+V" value={pasteDraft} onChange={(event) => setPasteDraft(event.target.value)}
        onPaste={(event) => {
          const files = Array.from(event.clipboardData.files);
          if (files.length) { event.preventDefault(); void pasteFiles(files); setPasteOpen(false); }
        }} />
      <Button size="sm" className={CONTROL_CLASS} disabled={!canPaste || !pasteDraft} onClick={() => {
        try { pasteText(pasteDraft); setPasteDraft(""); setPasteOpen(false); setMessage("Pasted."); }
        catch (e) { setMessage((e as Error).message); }
      }}>Insert</Button>
      <Button size="sm" className={CONTROL_CLASS} variant="ghost" onClick={() => { setPasteOpen(false); setPasteDraft(""); }}>Cancel</Button>
    </div>}
    {offeredText !== null && offeredText !== undefined && <div className="flex flex-wrap items-center gap-2 pt-2">
      <span className="text-xs text-[#9fb0c3]">The session copied text:</span>
      <textarea readOnly rows={2} value={offeredText} aria-label="Text copied by the session" className="min-w-0 flex-1 rounded border border-[#26303f] bg-[#0b0e14] p-2 font-mono text-xs" />
      <Button size="sm" className={CONTROL_CLASS} onClick={async () => {
        if (await writeClipboard(offeredText)) { setMessage("Copied."); onDismiss(); }
        else setMessage("Clipboard blocked. Select text in the terminal and use your browser's Copy command.");
      }}>Copy</Button>
      <Button size="sm" className={CONTROL_CLASS} variant="ghost" onClick={onDismiss}>Dismiss</Button>
    </div>}
    <div role="status" className="min-h-5 break-words pt-1 text-xs text-[#9fb0c3]">{message}</div>
  </div>;
}
