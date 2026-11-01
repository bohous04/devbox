// Overview of proxy profile context windows for the dashboard (AI subscriptions →
// Model context windows). A pure function over settings + an injected catalog,
// so it can be verified without the network; the API handler supplies the real lookup (openrouterModels).
import { AGENT_IDS, AGENTS } from "./agents";
import type { Settings } from "./config";
import { CLIPROXY_DEFAULT_CTX, contextOverride } from "./sessions";

export interface ProxyContextRow {
  /** modelKey from agents.ts — also the key for PUT /api/proxy-context/:key. */
  key: string;
  label: string;
  override: number | null;
  effective: number | null;
  source: "manual" | "default" | "catalog" | "unknown";
}

export async function proxyContextRows(settings: Settings, lookup: (model: string) => Promise<number | null>): Promise<ProxyContextRow[]> {
  const rows: ProxyContextRow[] = [];
  for (const id of AGENT_IDS) {
    const spec = AGENTS[id];
    if (!spec.modelKey || !spec.upstream) continue;
    const override = contextOverride(settings, spec.modelKey);
    if (override !== null) {
      rows.push({ key: spec.modelKey, label: spec.label, override, effective: override, source: "manual" });
      continue;
    }
    if (spec.upstream === "cliproxy") {
      rows.push({ key: spec.modelKey, label: spec.label, override: null, effective: CLIPROXY_DEFAULT_CTX, source: "default" });
      continue;
    }
    const model = settings.proxyModels?.[spec.modelKey];
    const measured = model ? await lookup(model) : null;
    rows.push(measured !== null
      ? { key: spec.modelKey, label: spec.label, override: null, effective: measured, source: "catalog" }
      : { key: spec.modelKey, label: spec.label, override: null, effective: null, source: "unknown" });
  }
  return rows;
}
