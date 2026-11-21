import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

export interface TriggerOption { value: string; label: string; detail?: string }

/** The list the composer opens above the field for `/` (the agent's commands) or `@` (the repo's files). Picked with
 *  the arrow keys and Enter or Tab in the field (Composer), or a click; the field keeps focus throughout. `status` is
 *  the line under the options (shown only; screen readers hear it from the composer's live region): searching, nothing found, a failure, or that more match. */
export function TriggerMenu({ id, title, options, active, status, stale = false, onPick, onHover }: {
  id: string;
  /** The options answer an earlier query (the next is on its way): shown dimmed, not pickable. */
  stale?: boolean;
  title: string;
  options: TriggerOption[];
  active: number;
  status?: { text: string; error?: boolean };
  onPick: (value: string) => void;
  onHover: (index: number) => void;
}) {
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => {
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);
  return (
    // mousedown anywhere in it (title, padding, status) must not take focus (and the caret) from the field.
    <div onMouseDown={(e) => e.preventDefault()} className="absolute inset-x-0 bottom-full z-30 mb-2 overflow-hidden rounded-xl border border-foreground/15 bg-popover text-popover-foreground shadow-lg dark:border-border">
      <p className="px-3 pb-1 pt-2 text-xs font-medium text-muted-foreground">{title}</p>
      {options.length > 0 && (
        <ul ref={list} id={id} role="listbox" aria-label={title} className={cn("max-h-64 overflow-y-auto px-1 pb-1", stale && "opacity-60")}>
          {options.map((o, i) => (
            <li
              key={`${i}:${o.value}`} id={`${id}-${i}`} data-index={i} role="option" aria-selected={i === active}
              // mousedown, not click: the field must not lose focus (and the caret) before the pick.
              onMouseDown={(e) => { e.preventDefault(); if (!stale) onPick(o.value); }}
              onMouseMove={() => { if (i !== active) onHover(i); }}
              className={cn("flex min-h-9 cursor-pointer items-center gap-3 rounded-lg px-2 py-1.5 text-sm max-sm:min-h-11", i === active && "bg-accent text-accent-foreground")}
            >
              <span className={cn("font-mono text-[13px]", o.detail ? "shrink-0" : "min-w-0 truncate")} title={o.detail ? undefined : o.label}>{o.label}</span>
              {o.detail && <span className="min-w-0 truncate text-xs text-muted-foreground" title={o.detail}>{o.detail}</span>}
            </li>
          ))}
        </ul>
      )}
      {/* Read out by the composer's own live region, which stays mounted (Composer). */}
      {status && <p aria-hidden="true" className={cn("px-3 pb-2 pt-1 text-xs", status.error ? "text-destructive" : "text-muted-foreground")}>{status.text}</p>}
    </div>
  );
}
