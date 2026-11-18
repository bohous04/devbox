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
  private seq: number;
  // Computed once on open so append() never has to re-read the file.
  private tailUnterminated: boolean;

  constructor(private readonly path: string) {
    const events = parseComplete(path);
    this.seq = events.length ? events[events.length - 1].seq : 0;
    const text = existsSync(path) ? readFileSync(path, "utf8") : "";
    this.tailUnterminated = text.length > 0 && !text.endsWith("\n");
  }

  append(event: BridgeEvent): LoggedEvent {
    const logged: LoggedEvent = { seq: this.seq + 1, ts: Date.now(), event };
    // Leading newline terminates any torn line left by a crash, so this record starts clean.
    appendFileSync(this.path, `${this.tailUnterminated ? "\n" : ""}${JSON.stringify(logged)}\n`);
    this.tailUnterminated = false;
    this.seq = logged.seq;
    return logged;
  }

  lastSeq(): number {
    return this.seq;
  }

  readFrom(afterSeq: number): LoggedEvent[] {
    return parseComplete(this.path).filter((e) => e.seq > afterSeq);
  }
}
