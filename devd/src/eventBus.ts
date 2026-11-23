export type BusTopic = "inbox" | "inbox-ended" | `thread:${string}` | `mirror:${string}`;
export type BusListener = (topic: BusTopic, data: unknown) => void;

/** In-process fan-out from devd's event sources (bridge links, the inbox) to SSE connections. Synchronous:
 *  `publish` returns after every subscriber ran. A throwing subscriber is logged and does not stop the others. */
export class EventBus {
  private subs = new Map<BusTopic, Set<BusListener>>();
  private log: (msg: string) => void;

  constructor(d: { log?: (msg: string) => void } = {}) {
    this.log = d.log ?? ((msg) => console.error(msg));
  }

  publish(topic: BusTopic, data: unknown): void {
    const set = this.subs.get(topic);
    if (!set) return;
    for (const cb of [...set]) {
      try { cb(topic, data); }
      catch (e) { this.log(`event bus: subscriber of ${topic} failed: ${(e as Error).message}`); }
    }
  }

  subscribe(topics: BusTopic[], cb: BusListener): () => void {
    for (const t of topics) {
      let set = this.subs.get(t);
      if (!set) { set = new Set(); this.subs.set(t, set); }
      set.add(cb);
    }
    return () => {
      for (const t of topics) {
        const set = this.subs.get(t);
        if (!set) continue;
        set.delete(cb);
        if (set.size === 0) this.subs.delete(t);
      }
    };
  }

  /** Distinct listeners across all topics (diagnostics, tests). */
  subscriberCount(): number {
    const all = new Set<BusListener>();
    for (const set of this.subs.values()) for (const cb of set) all.add(cb);
    return all.size;
  }
}
