// Model context window from the public OpenRouter /v1/models (no key). For an
// unrecognized model cc assumes a 200k window and the session then keeps compacting — the measured
// window goes into the container as DEVD_AGENT_CTX (see proxyEnv + agent-launch.sh).

export async function openrouterContextLength(model: string, baseUrl: string, fetchImpl: typeof fetch = fetch): Promise<number | null> {
  try {
    const r = await fetchImpl(`${baseUrl}/v1/models`, { signal: AbortSignal.timeout(2000) });
    if (!r.ok) return null;
    const body = (await r.json()) as { data?: { id?: string; context_length?: number }[] };
    const m = body.data?.find((x) => x.id === model);
    return typeof m?.context_length === "number" ? m.context_length : null;
  } catch {
    return null;
  }
}

// Success is kept for the life of the process (no HTTP request on every session open),
// failure is NOT cached — after an OpenRouter outage the window is re-measured on the next open,
// not only after a devd restart.
const defaultCache = new Map<string, number>();

export async function contextLengthCached(model: string, baseUrl: string, fetchImpl: typeof fetch = fetch, cache: Map<string, number> = defaultCache): Promise<number | null> {
  const hit = cache.get(model);
  if (hit !== undefined) return hit;
  const v = await openrouterContextLength(model, baseUrl, fetchImpl);
  if (v !== null) cache.set(model, v);
  return v;
}
