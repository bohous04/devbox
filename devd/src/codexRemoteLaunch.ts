// Remote's dispatcher calls back into devd while an account switch still owns
// the session lifecycle lock. This capability permits only a read-only running
// workspace confirmation; it never releases or replaces that lifecycle lock.
const scopes = new WeakMap<Set<string>, Map<string, symbol>>();

export function codexRemoteLaunchScope(inFlight: Set<string> | undefined, sessionId: string): symbol | undefined {
  return inFlight?.has(sessionId) ? scopes.get(inFlight)?.get(sessionId) : undefined;
}

export function beginCodexRemoteLaunch(inFlight: Set<string>, sessionId: string): () => void {
  let active = scopes.get(inFlight);
  if (!inFlight.has(sessionId) || active?.has(sessionId)) throw new Error("Codex Remote launch requires its exclusive account-switch lock");
  if (!active) { active = new Map(); scopes.set(inFlight, active); }
  const scope = Symbol(sessionId);
  active.set(sessionId, scope);
  return () => { if (active.get(sessionId) === scope) active.delete(sessionId); };
}
