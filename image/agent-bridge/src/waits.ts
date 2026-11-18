import type { BackgroundWork } from "./events";

export const DEFAULT_WAIT_MINUTES = 60;
export const MAX_WAIT_MINUTES = 240;

/** The agent's own declaration that it is waiting for a command or CI. Owned by the bridge, not an adapter. */
export class DeclaredWaits {
  private work: (BackgroundWork & { until: number }) | null = null;

  constructor(
    private now: () => number,
    private onChange: (work: BackgroundWork[]) => void,
  ) {}

  declare(reason: string, kind: "command" | "ci", timeoutMinutes: number = DEFAULT_WAIT_MINUTES): { until: number } {
    if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0 || timeoutMinutes > MAX_WAIT_MINUTES) {
      throw new Error(`timeoutMinutes must be greater than 0 and at most ${MAX_WAIT_MINUTES}`);
    }
    const until = this.now() + timeoutMinutes * 60_000;
    // One declaration at a time: a new one replaces the previous.
    this.work = { id: "declared-wait", kind: "declared-wait", label: `${kind}: ${reason}`, holding: true, until };
    this.onChange(this.current());
    return { until };
  }

  clear(): void {
    if (!this.work) return;
    this.work = null;
    this.onChange([]);
  }

  /** Drops an expired declaration and reports the change; call periodically. */
  sweep(): void {
    if (this.work && this.work.until <= this.now()) this.clear();
  }

  current(): BackgroundWork[] {
    return this.work ? [{ ...this.work }] : [];
  }
}
