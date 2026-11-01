import { AGENT_RUNTIMES } from "./agents";

/** Destination path from a docker `-v` spec (`name:/path` or `name:/path:ro`). */
export function mountSpecDestination(spec: string): string | null {
  const dest = spec.split(":").find(part => part.startsWith("/"));
  return dest ?? null;
}

/** True when at least one expected account mount is missing from the container. */
export function staleAccountMounts(expectedSpecs: string[], observedDestinations: string[]): boolean {
  const observed = new Set(observedDestinations);
  return expectedSpecs.some(spec => {
    const dest = mountSpecDestination(spec);
    return dest !== null && !observed.has(dest);
  });
}

export function observedMountDestinations(inspectJson: unknown): string[] | null {
  if (!Array.isArray(inspectJson)) return null;
  const dests: string[] = [];
  for (const mount of inspectJson) {
    if (!mount || typeof mount !== "object" || !("Destination" in mount)) return null;
    if (typeof mount.Destination !== "string") return null;
    dests.push(mount.Destination);
  }
  return dests;
}

/** True when a live agent TUI is present. Unknown comms are ignored. */
export function liveAgentPresent(comms: string[]): boolean {
  const runtimes = new Set<string>(AGENT_RUNTIMES);
  return comms.some(comm => runtimes.has(comm));
}
