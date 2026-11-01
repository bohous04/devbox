import type { Database } from "bun:sqlite";
import type { Settings } from "./config";

export class NoPortsError extends Error {}

export function allocatePortBase(db: Database, settings: Settings): number {
  // Ranges, not starts. Existing sessions may have been created under a DIFFERENT
  // `portsPerSession` (blocks of ten), so matching starts is not enough: block 40105
  // is not in the list of taken ones, but lies inside the range 40100-40109 and docker would
  // fail on it only at `docker run` — i.e. with an error that does not look like a port error.
  //
  // We do not know the width of already taken blocks (the DB only has the start), so it is computed with
  // the WIDEST one that ever applied. Errors here must be on the side of wasting ports, not
  // on the side of overlap.
  const WIDEST_HISTORICAL_BLOCK = 10;
  const used = (db.query(`SELECT port_base FROM sessions`).all() as { port_base: number }[])
    .map((r) => r.port_base);
  const width = settings.portsPerSession;
  const overlaps = (base: number) =>
    used.some((u) => base < u + WIDEST_HISTORICAL_BLOCK && u < base + width);

  for (let i = 0; i < 100; i++) {
    const base = settings.portRangeStart + i * width;
    if (!overlaps(base)) return base;
  }
  throw new NoPortsError("No free port blocks (100 sessions cap)");
}
