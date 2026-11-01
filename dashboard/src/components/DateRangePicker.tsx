import { useEffect, useState } from "react";
import type { DateRange } from "react-day-picker";
import { CalendarIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { PRESETS, matchPreset, presetRange, rangeFromDraft, type RangePresetId } from "@/lib/range";

function fmt(t: number) { return new Date(t).toLocaleDateString("en-US", { day: "numeric", month: "numeric" }); }

/** Two months side by side fit from `sm` up. There used to be TWO calendar
 *  instances here (one hidden via CSS) — both were alive, both captured the keyboard
 *  and focus. Now there is one and a media query decides the number of months. */
function useTwoMonths(): boolean {
  const [two, setTwo] = useState(() => window.matchMedia("(min-width: 640px)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 640px)");
    const on = () => setTwo(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return two;
}

export function DateRangePicker({ value, onChange }: { value: { from: number; to: number }; onChange: (r: { from: number; to: number }) => void }) {
  const [open, setOpen] = useState(false);
  // Selection in progress. The draft exists because react-day-picker returns {from,to}
  // (both the same) ALREADY from the first click — so the response shape does not tell whether
  // the user is done. Previously the selection was applied immediately and one click moved only
  // one end ("29. 7. – 20. 8."), on top of that with an immediate server request.
  // That is why it is applied only by the button, not by clicking in the calendar.
  const [draft, setDraft] = useState<DateRange | undefined>(undefined);
  const twoMonths = useTwoMonths();
  const active = matchPreset(value, Date.now());

  const applyPreset = (id: RangePresetId) => {
    if (id === "custom") return;
    onChange(presetRange(id, Date.now()));
  };

  const apply = () => {
    const range = rangeFromDraft(draft);
    if (!range) return;
    onChange(range);
    setOpen(false);
    setDraft(undefined);
  };

  const span = (from: number, toExclusive: number) =>
    toExclusive - from <= 86_400_000 ? fmt(from) : `${fmt(from)} – ${fmt(toExclusive - 86_400_000)}`;
  const drafted = rangeFromDraft(draft);
  const label = span(value.from, value.to);

  return (
    // On mobile the presets wrap into a grid instead of an overflowing row.
    <div className="flex flex-wrap items-center gap-1.5">
      {PRESETS.filter((p) => p.id !== "custom").map((p) => (
        <Button
          key={p.id}
          variant={active === p.id ? "secondary" : "outline"}
          size="sm"
          onClick={() => applyPreset(p.id)}
        >
          {p.label}
        </Button>
      ))}
      <Popover
        open={open}
        onOpenChange={(o) => { setOpen(o); setDraft(undefined); }}   // closing discards the pending selection
      >
        <PopoverTrigger asChild>
          <Button variant={active === "custom" ? "secondary" : "outline"} size="sm" className="gap-2">
            <CalendarIcon className="h-4 w-4" />
            {label}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="end">
          <Calendar
            mode="range"
            autoFocus
            numberOfMonths={twoMonths ? 2 : 1}
            // Opens on the month of the range END — for "90 days" today is the interesting part,
            // not a quarter back.
            defaultMonth={new Date(value.to - 86_400_000)}
            // Stats for the future do not exist; future days cannot be selected.
            disabled={{ after: new Date() }}
            selected={draft}
            onSelect={setDraft}
          />
          <div className="flex items-center justify-between gap-3 border-t px-3 py-2">
            <span className="text-xs text-muted-foreground">
              {drafted ? span(drafted.from, drafted.to) : "Pick a start day, then an end day"}
            </span>
            <div className="flex gap-1.5">
              <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>Cancel</Button>
              <Button size="sm" disabled={!drafted} onClick={apply}>Apply</Button>
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
