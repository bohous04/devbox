import { TriangleAlert, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { settler, useSettleState } from "../useSettler";

/** The last settle, undo or seen failure (settler.state.problem), until the owner dismisses it. */
export function SettleProblem({ className }: { className?: string }) {
  const { problem } = useSettleState();
  if (!problem) return null;
  return (
    <div role="alert" className={cn("flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-foreground", className)}>
      <TriangleAlert className="mt-0.5 size-4 flex-none text-destructive" aria-hidden="true" />
      <span className="min-w-0 flex-1">{problem}</span>
      <button type="button" onClick={() => settler.dismiss()} aria-label="Dismiss" title="Dismiss"
        className="-my-1 -mr-1 grid size-7 flex-none place-items-center rounded-md text-muted-foreground outline-none hover:bg-foreground/10 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60">
        <X className="size-4" aria-hidden="true" />
      </button>
    </div>
  );
}
