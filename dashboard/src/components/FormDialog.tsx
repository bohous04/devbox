import { useRef, type ReactNode } from "react";
import { Dialog } from "radix-ui";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Shared modal for short dashboard tasks: focus trap, Escape, accessible title,
 * scrollable mobile layout and focus restoration even for an external trigger. */
export function FormDialog({ open, onOpenChange, title, description, busy = false, children }: {
  open: boolean; onOpenChange: (open: boolean) => void; title: string;
  description: string; busy?: boolean; children: ReactNode;
}) {
  const returnFocus = useRef<HTMLElement | null>(null);
  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/45" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-50 max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border bg-background p-5 shadow-xl outline-none sm:p-6"
          onOpenAutoFocus={() => { returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; }}
          onCloseAutoFocus={(event) => { event.preventDefault(); returnFocus.current?.focus(); }}
          onEscapeKeyDown={(event) => { if (busy) event.preventDefault(); }}
          onPointerDownOutside={(event) => { if (busy) event.preventDefault(); }}
        >
          <div className="mb-5 pr-10">
            <Dialog.Title className="text-lg font-semibold tracking-tight">{title}</Dialog.Title>
            <Dialog.Description className="mt-1 text-sm text-muted-foreground">{description}</Dialog.Description>
          </div>
          {children}
          <Dialog.Close asChild>
            <Button type="button" variant="ghost" size="icon" disabled={busy} aria-label="Close dialog" className="absolute right-2 top-2 min-h-11 min-w-11"><X className="size-4" /></Button>
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
