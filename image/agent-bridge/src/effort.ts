import type { BridgeEvent } from "./events.ts";

export type EffortEvent = Extract<BridgeEvent, { type: "effort.state" }>;

/** What a harness reports about reasoning effort (bridge 1.7.0): `supported` null = the harness has not said yet,
 *  [] = the model has no levels; `effective` null = not known (Claude reports it only after a turn); `chosen` null =
 *  the harness's own default. Emits `effort.state` whenever any of it changes.
 *  `unchecked` (1.8.0): levels taken while `supported` is null, before the harness names its model; the model's own
 *  list checks a choice once it arrives (`update`), dropping it with a notice. effort.state carries them then; a
 *  model named while they are still offered means its list could not check them. Cleared once a model is explicit. */
export class EffortState {
  private model: string | null = null;
  private supported: string[] | null = null;
  private effective: string | null = null;
  private last = "";

  constructor(private emit: (e: BridgeEvent) => void, private chosenLevel: string | null, private unchecked: readonly string[] = []) {}

  get chosen(): string | null {
    return this.chosenLevel;
  }

  get levels(): string[] | null {
    return this.supported;
  }

  /** New facts from the harness. A choice the (new) model does not offer goes back to the default, said once; true
   *  when that happened (the harness then drops the level it was given).
   *  `effective` may depend on the choice that remains. */
  update(p: {
    model?: string | null; supported?: string[] | null; effective?: string | null | ((chosen: string | null) => string | null);
    unchecked?: readonly string[];
    /** The level a message already went out with before it was checked: dropping that one says the message ran at
     *  the model's nearest level (Claude's CLI downgrades silently). */
    sentUnchecked?: string | null;
  }): boolean {
    if (p.model !== undefined) this.model = p.model;
    if (p.supported !== undefined) this.supported = p.supported;
    if (p.unchecked !== undefined) this.unchecked = p.unchecked;
    let dropped: string | null = null;
    if (this.chosenLevel !== null && this.supported !== null && !this.supported.includes(this.chosenLevel)) {
      dropped = this.chosenLevel;
      this.chosenLevel = null;
    }
    if (p.effective !== undefined) this.effective = typeof p.effective === "function" ? p.effective(this.chosenLevel) : p.effective;
    if (dropped !== null) {
      const on = `Effort ${dropped} is not available on ${this.model ?? "this model"}`;
      this.emit({ type: "bridge.notice", text: dropped === p.sentUnchecked
        ? `${on}: the message sent with it ran at the model's nearest level. Back to its default from now on.`
        : `${on}; back to its default.` });
    }
    this.publish();
    return dropped !== null;
  }

  /** Throws when the level is not one the current model offers (or none are known yet). */
  check(level: string | null): void {
    if (level !== null) {
      if (this.supported === null) {
        if (this.unchecked.length === 0) throw new Error("the agent has not reported its effort levels yet; try again after its first reply");
        if (!this.unchecked.includes(level)) throw new Error(`effort ${level} is not one of ${this.unchecked.join(", ")}`);
        return;
      }
      if (!this.supported.includes(level)) {
        throw new Error(this.supported.length === 0 ? `${this.model ?? "this model"} has no effort levels` : `effort ${level} is not one of ${this.supported.join(", ")}`);
      }
    }
  }

  /** Commits a level `check` accepted and the harness took. `effective`: what the harness runs from now, if known.
   *  The model's levels may have arrived meanwhile (an unchecked level): one it lacks is dropped as `update` drops
   *  it; true then, and the harness resets the level it was given. */
  choose(level: string | null, effective: string | null): boolean {
    this.chosenLevel = level;
    this.effective = effective;
    return this.update({});
  }

  private publish(): void {
    const e: EffortEvent = {
      type: "effort.state", model: this.model, supported: this.supported, effective: this.effective, chosen: this.chosenLevel,
      ...(this.supported === null && this.unchecked.length > 0 ? { unchecked: [...this.unchecked] } : {}),
    };
    const key = JSON.stringify(e);
    if (key === this.last) return;
    this.last = key;
    this.emit(e);
  }
}
