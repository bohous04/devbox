import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ArrowUp, LoaderCircle, Paperclip, Square, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ApiError } from "../../api";
import { MAX_IMAGES_PER_MESSAGE, prepareImage, takeImages } from "../../imageView";
import { composerErrorText } from "../../threadView";

interface Attached { key: number; blob: Blob; url: string }

/** Below Tailwind's sm (40rem), the same query as the 44px touch-target rule in index.css. */
const PHONE = "(max-width: 639.98px)";

let measureCanvas: HTMLCanvasElement | null = null;
/** Width of one line of text in the field's font. */
function textWidth(text: string, css: CSSStyleDeclaration): number {
  measureCanvas ??= document.createElement("canvas");
  const ctx = measureCanvas.getContext("2d");
  if (!ctx) throw new Error("No 2d canvas context to measure the message text");
  ctx.font = `${css.fontStyle} ${css.fontWeight} ${css.fontSize} ${css.fontFamily}`;
  return ctx.measureText(text).width;
}

/** Message input: with a mouse/trackpad Enter sends and Shift+Enter is a newline; on touch Enter is a newline and
 *  the Send button sends. A message sent while a run is active is queued by the
 *  bridge and shows as queued in the thread. On a failed send the text stays and nothing is retried.
 *  Images pasted, dropped or picked (at most 10) are scaled down (imageView.ts), previewed and go with the next message.
 *  While a run is active and nothing is typed, the round primary button stops the run; with text typed it sends
 *  (queues) and a separate stop button sits next to it. */
export function Composer({ running, onSend, onStop, controls, notices, placeholder: placeholderText, start, onDraft, fieldOff, imagesOff, card = false }: {
  running: boolean;
  /** Replaces the default placeholder (e.g. the new-session page's). */
  placeholder?: string;
  /** The new-session page: the primary button starts a session, also with nothing typed, once `ready`. */
  start?: { label: string; ready: boolean };
  /** Hears every change of the typed text (the new-session page decides what can start with it). */
  onDraft?: (text: string) => void;
  /** Why this message cannot take text: the field is disabled while empty (typed text stays editable, to clear it). */
  fieldOff?: string;
  /** Always the two-tier card, also on a phone at rest (the new-session page: a start screen with room for it). */
  card?: boolean;
  /** Why this message cannot take images: attaching is disabled, a paste or drop says why. */
  imagesOff?: string;
  /** Inside the box, bottom right: the session's agent, model and account switchers. */
  controls?: ReactNode;
  /** Above the box: the switchers' status and error lines. */
  notices?: ReactNode;
  onSend: (text: string, images: Blob[]) => Promise<void>;
  onStop: () => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [images, setImages] = useState<Attached[]>([]);
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  // Scrolled past its top (above the height cap): the top edge fades so no line is cut hard.
  const [scrolled, setScrolled] = useState(false);
  // Phones (below sm) show one row (attach, field, model chip, send) while the text fits one line and no image is
  // attached; otherwise the two-tier card (the field on top across the full width, the toolbar below). Only the
  // container's classes change, never the textarea element, so focus, caret and the on-screen keyboard survive.
  const [twoTier, setTwoTier] = useState(false);
  const oneRow = !card && !twoTier && images.length === 0;
  // The field's width in the one-row layout with text (the chip then shows only its mark), for the way back.
  const oneRowWidth = useRef(0);
  const [redecide, setRedecide] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const nextKey = useRef(0);
  const picker = useRef<HTMLInputElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  // Grows with the text up to the CSS max height, then scrolls. Re-measured when the text or the attached images change
  // and when the field's width changes (window resize, rotation): the same text wraps differently.
  const fit = useCallback(() => {
    const el = field.current;
    if (!el) return;
    const top = el.scrollTop;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
    // Above the height cap it scrolls. Typing at the end shows the very end (the browser alone scrolls only until the
    // caret line shows, leaving the top line cut); otherwise the scroll position stays where it was.
    el.scrollTop = el.selectionStart === el.value.length ? el.scrollHeight : top;
    setScrolled(el.scrollTop > 0);
  }, []);
  // Which phone layout the text needs, decided on text and image changes only (never on the switch itself, so it cannot
  // loop). Hysteresis: to the card when the one-row field wraps; back only when the text fits one line 8px short of
  // the one-row width, so typing and deleting at the boundary does not flap.
  useLayoutEffect(() => {
    const el = field.current;
    if (!el || !window.matchMedia(PHONE).matches) return;
    const css = getComputedStyle(el);
    if (oneRow) {
      if (text === "") return;
      oneRowWidth.current = el.clientWidth;
      el.style.height = "auto";
      const lines = (el.scrollHeight - parseFloat(css.paddingTop) - parseFloat(css.paddingBottom)) / parseFloat(css.lineHeight);
      if (lines > 1.5) setTwoTier(true);
    } else if (twoTier && !text.includes("\n") && textWidth(text, css) <= oneRowWidth.current - 8) {
      setTwoTier(false);
    }
  }, [text, images.length, redecide]); // eslint-disable-line react-hooks/exhaustive-deps -- see above: not on the switch itself
  // A new box width (rotation, window resize) wraps the text differently: start from one row and decide again. The
  // box, not the field: the field's width changes with the switch itself.
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    let width = box.clientWidth;
    const observer = new ResizeObserver(() => {
      if (box.clientWidth === width) return;
      width = box.clientWidth;
      oneRowWidth.current = 0;
      setTwoTier(false);
      setRedecide((n) => n + 1);
    });
    observer.observe(box);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(fit, [fit, text, images.length, twoTier]);
  useEffect(() => {
    const el = field.current;
    if (!el) return;
    let width = el.clientWidth;
    const observer = new ResizeObserver(() => {
      // Only a width change: fit() itself changes the height, which would otherwise call back here.
      if (el.clientWidth !== width) { width = el.clientWidth; fit(); }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [fit]);
  const urls = useRef(new Set<string>());
  useEffect(() => () => { for (const u of urls.current) URL.revokeObjectURL(u); }, []);

  const errorText = (e: unknown) => (e instanceof ApiError ? composerErrorText(e.status, e.body) : (e as Error).message);

  async function attach(files: File[]) {
    if (imagesOff) { setErr(imagesOff); return; }
    const { take, message } = takeImages(images.length, files.length);
    setErr(message);
    for (const file of files.slice(0, take)) {
      try {
        const blob = await prepareImage(file);
        const url = URL.createObjectURL(blob);
        urls.current.add(url);
        setImages((cur) => [...cur, { key: nextKey.current++, blob, url }]);
      } catch (e) { setErr(`${file.name || "image"}: ${(e as Error).message}`); }
    }
  }

  function detach(drop: Attached[]) {
    for (const a of drop) { URL.revokeObjectURL(a.url); urls.current.delete(a.url); }
    setImages((cur) => cur.filter((a) => !drop.includes(a)));
  }

  async function send() {
    if (busy || !canSend) return;
    setBusy(true); setErr(null);
    const sent = text;
    const sentImages = images;
    // Text typed and images added while the send was in flight stay.
    try { await onSend(sent, sentImages.map((a) => a.blob)); setText((cur) => (cur === sent ? "" : cur)); detach(sentImages); }
    catch (e) { setErr(errorText(e)); }
    finally { setBusy(false); }
  }

  async function stop() {
    setStopping(true); setErr(null);
    try { await onStop(); }
    catch (e) { setErr(errorText(e)); }
    finally { setStopping(false); }
  }

  const empty = text.trim() === "";
  const canSend = start ? start.ready : !empty;
  // Enter sends only with a mouse or trackpad (see onKeyDown), so only then is the keyboard hint shown.
  const finePointer = window.matchMedia("(pointer: fine)").matches;
  const placeholder = placeholderText ?? (running ? "Queue a message for after this run" : "Ask anything");
  const full = images.length >= MAX_IMAGES_PER_MESSAGE;
  // Round buttons: below sm the hit area is 44px (size-11, the same minimum index.css sets for buttons there), the
  // visible circle stays 32px so it matches the icons.
  const round = "group flex size-11 shrink-0 items-center justify-center rounded-full sm:size-8";
  const dot = "flex size-8 items-center justify-center rounded-full transition-colors";
  const stopIcon = stopping ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : <Square className="size-3 fill-current" aria-hidden="true" />;
  // Running with nothing typed: the primary button stops the run. It stays the same element as Send, so keyboard focus
  // survives the swap.
  const stopPrimary = running && empty;

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => { e.preventDefault(); void send(); }}
      onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDragging(true); } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false); }}
      onDrop={(e) => {
        setDragging(false);
        if (e.dataTransfer.files.length === 0) return;
        e.preventDefault(); void attach(Array.from(e.dataTransfer.files));
      }}
    >
      {notices && <div className="px-1">{notices}</div>}
      <div
        ref={boxRef}
        // On a phone's one row with text, the model chip shows only its mark (Switchers reads this).
        data-chip={oneRow && text !== "" ? "mark" : "full"}
        className={cn(
          "group/box flex flex-col rounded-2xl border border-foreground/15 bg-background transition-colors duration-150 motion-reduce:transition-none dark:border-border dark:bg-card",
          // Focus: the same 1px border, a step darker (lighter in dark), so it reads as one line.
          "focus-within:border-foreground/35 dark:focus-within:border-foreground/35",
          dragging && "border-primary/70 bg-accent/40",
        )}
      >
        {images.length > 0 && (
          <ul className="flex flex-wrap gap-2 px-3 pt-3" aria-label="Attached images">
            {images.map((a) => (
              <li key={a.key} className="relative">
                <img src={a.url} alt="" className="size-14 rounded-lg border object-cover" />
                <button
                  type="button" aria-label="Remove image" title="Remove image" onClick={() => detach([a])}
                  className="absolute -right-1.5 -top-1.5 flex size-5 items-center justify-center rounded-full border bg-background text-muted-foreground shadow-sm hover:text-foreground"
                >
                  <X className="size-3" />
                </button>
              </li>
            ))}
          </ul>
        )}
        {/* The field above the toolbar row; on a phone's one row, everything side by side. */}
        <div className={cn("flex flex-col", oneRow && "max-sm:flex-row max-sm:items-center max-sm:p-0.5")}>
          {/* The padding sits on this wrapper, the scrolling happens in the field below it: nothing scrolls into the
              space under the card's top border. */}
          <div className={cn("px-4 pt-3", oneRow && "max-sm:min-w-0 max-sm:flex-1 max-sm:px-1 max-sm:py-2.5")}>
            <textarea
              ref={field}
              aria-label="Message"
              rows={1}
              placeholder={placeholder}
              className={cn(
                // Caps: six whole lines plus the bottom padding on phones (148px), twelve from sm (292px); then it
                // scrolls. From sm the card rests two lines tall, so it reads as a message box.
                "block max-h-[148px] w-full resize-none bg-transparent pb-1 text-base leading-6 outline-none placeholder:text-muted-foreground sm:max-h-[292px] sm:min-h-[52px]",
                oneRow && "max-sm:pb-0",
                // Scrolled: the top 12px of the field fade out, inside the field, so nothing is cut hard at its edge.
                scrolled && "[mask-image:linear-gradient(to_bottom,transparent,black_0.75rem)]",
                // An empty phone row keeps the placeholder on its line instead of wrapping it.
                text === "" && !card && "max-sm:overflow-hidden max-sm:whitespace-nowrap",
                // The card on a phone rests two lines tall too, as it does from sm.
                card && "min-h-[52px]",
              )}
              onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 0)}
              value={text}
              disabled={fieldOff !== undefined && text === ""}
              onChange={(e) => { setText(e.target.value); onDraft?.(e.target.value); }}
              onPaste={(e) => {
                const files = Array.from(e.clipboardData.files);
                if (files.length === 0) return;
                e.preventDefault(); void attach(files);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && window.matchMedia("(pointer: fine)").matches) {
                  e.preventDefault(); void send();
                }
              }}
            />
          </div>
          {/* Phones: the same 2px inset as the one row, so the controls do not shift sideways on the switch. */}
          <div className={cn("flex items-center gap-0.5 px-0.5 pb-0.5 sm:gap-1 sm:px-2 sm:pb-2", oneRow && "max-sm:contents")}>
            <input
              ref={picker} type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple className="hidden"
              onChange={(e) => { const files = Array.from(e.target.files ?? []); e.target.value = ""; void attach(files); }}
            />
            <Button
              type="button" variant="ghost" size="icon-sm" disabled={full || imagesOff !== undefined}
              className={cn("size-11 rounded-full text-muted-foreground hover:text-foreground sm:size-8 [&_svg]:size-[18px]", oneRow && "max-sm:order-first")}
              onClick={() => picker.current?.click()} aria-label="Attach image" title={imagesOff ?? (full ? `At most ${MAX_IMAGES_PER_MESSAGE} images per message` : "Attach image (PNG, JPEG, WebP or GIF), or paste or drop one")}
            >
              <Paperclip />
            </Button>
            {finePointer && (
              // Quiet, and only while typing: the placeholder stays short.
              <p aria-hidden="true" className="ml-1 hidden truncate text-xs text-muted-foreground opacity-0 transition-opacity duration-150 group-focus-within/box:opacity-100 sm:block">
                Enter to send · Shift+Enter for a new line{imagesOff ? "" : " · paste or drop images"}
              </p>
            )}
            <div className={cn("ml-auto flex min-w-0 items-center gap-0.5 sm:gap-1", oneRow && "max-sm:shrink-0")}>
              {controls}
              {running && !empty && (
                <button type="button" disabled={stopping} onClick={() => void stop()} aria-label="Stop the run" title="Stop the run" className={round}>
                  <span className={cn(dot, "border bg-background text-foreground group-hover:bg-accent group-disabled:opacity-50")}>{stopIcon}</span>
                </button>
              )}
              <button
                type={stopPrimary ? "button" : "submit"} disabled={stopPrimary ? stopping : busy || !canSend}
                onClick={stopPrimary ? () => void stop() : undefined}
                aria-label={stopPrimary ? "Stop the run" : start?.label ?? "Send"} title={stopPrimary ? "Stop the run" : `${start?.label ?? "Send"}${finePointer ? " (Enter)" : ""}`}
                className={round}
              >
                {/* A muted filled circle while empty (its arrow keeps 3:1 against the circle and the card), the primary
                    one once there is something to send or a run to stop. */}
                <span className={cn(dot, stopPrimary
                  ? "bg-primary text-primary-foreground shadow-sm group-hover:bg-primary/85 group-disabled:opacity-50"
                  : !canSend ? "bg-foreground/[0.08] text-foreground/55 dark:text-foreground/65"
                  : "bg-primary text-primary-foreground shadow-sm group-hover:bg-primary/85")}>
                  {stopPrimary ? stopIcon : busy ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : <ArrowUp className="size-4" strokeWidth={2.5} aria-hidden="true" />}
                </span>
              </button>
            </div>
          </div>
        </div>
      </div>
      {err && <p role="alert" className="px-1 text-sm text-destructive">{err}</p>}
    </form>
  );
}
