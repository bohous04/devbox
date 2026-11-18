import { appendFileSync, existsSync, readFileSync } from "node:fs";
import type { BridgeEvent, LoggedEvent } from "./events";

function parseComplete(path: string): LoggedEvent[] {
  if (!existsSync(path)) return [];
  const out: LoggedEvent[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as LoggedEvent);
    } catch {
      // A crash mid-append leaves a torn line; only complete lines count.
    }
  }
  return out;
}

export class EventLog {
  private lastSeq: number;

  constructor(private readonly path: string) {
    const events = parseComplete(path);
    this.lastSeq = events.length ? events[events.length - 1].seq : 0;
  }

  append(event: BridgeEvent): LoggedEvent {
    const logged: LoggedEvent = { seq: this.lastSeq + 1, ts: Date.now(), event };
    // Leading newline terminates any torn line left by a crash, so this record starts clean.
    appendFileSync(this.path, `${this.needsNewline() ? "\n" : ""}${JSON.stringify(logged)}\n`);
    this.lastSeq = logged.seq;
    return logged;
  }

  readFrom(afterSeq: number): LoggedEvent[] {
    return parseComplete(this.path).filter((e) => e.seq > afterSeq);
  }

  private needsNewline(): boolean {
    if (!existsSync(this.path)) return false;
    const text = readFileSync(this.path, "utf8");
    return text.length > 0 && !text.endsWith("\n");
  }
}
