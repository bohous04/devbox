// Pure presentation logic for the Operations database onboarding flow.
export interface DbRequestBlock {
  code: string;
  category: "configuration" | "connection" | "permission" | "decision";
  message: string;
  action: string;
  instance?: string;
  candidateId?: string;
}

export interface DbCandidate {
  id: string; instance?: string; server: string; container: string; engine: string; name: string;
  db?: string; environment?: string; application?: string; applicationName?: string; verified?: boolean; matched?: boolean;
}

export interface DbDiscovery { candidates: DbCandidate[]; blocks: DbRequestBlock[] }

export interface ProvisionForm {
  server: string; sshAlias: string; container: string; engine: string;
  db: string; roUser: string; hostPort: number; opItem: string; opVault?: string;
  /** This only enables proposals. Every SQL write still needs separate approval. */
  write: boolean; migrations?: boolean; rwUser: string; rwOpItem: string; candidateId?: string;
}

export interface DbOnboardingPlan {
  entry: { name: string; server: string; engine: string; db: string; hostPort: number; roUser: string; rwUser?: string };
  input: Partial<ProvisionForm>;
  write?: boolean; migrations?: boolean;
  changes: string[];
}

export interface DbRequestRow {
  id: number; ts: number; session_id: string | null; project: string | null;
  wanted: string; why: string; status: string; decided_at: number | null; note: string | null;
  requested_scope?: "read" | "dml" | "migration";
  state?: string; operationId?: number | null; plan?: DbOnboardingPlan | null;
  blocks?: DbRequestBlock[]; nextAction?: string; step?: string | null;
}

const MAX_SUMMARY = 120;
export function requestSummary(r: DbRequestRow): string {
  const base = `${r.wanted} · ${r.project ?? r.session_id ?? "?"} · `;
  const why = r.why || "(no purpose supplied)";
  const room = Math.max(1, MAX_SUMMARY - base.length);
  return base + (why.length > room ? why.slice(0, room - 1) + "…" : why);
}

/** Project names are not server names. Only a discovered target supplies a server. */
export function prefill(r: DbRequestRow): ProvisionForm {
  const name = r.wanted.trim();
  return {
    server: "", sshAlias: "", container: "", engine: "postgres", db: name,
    roUser: `${name.replace(/[^a-zA-Z0-9_]/g, "_")}_ro`, hostPort: 0,
    opItem: `prod-ro ${name}`, write: r.requested_scope === "dml" || r.requested_scope === "migration",
    migrations: r.requested_scope === "migration",
    rwUser: `${name.replace(/[^a-zA-Z0-9_]/g, "_")}_rw`, rwOpItem: `prod-rw ${name}`,
    ...r.plan?.input,
    ...(r.plan ? { server: r.plan.entry.server, write: !!r.plan.write, migrations: !!r.plan.migrations } : {}),
  };
}

/** Polling may raise the requested scope, but never discard a selected target,
 * override an edited form, or alter the scope of an immutable Operations plan. */
export function refreshProvisionForm(current: ProvisionForm, row: DbRequestRow, edited: boolean): ProvisionForm {
  if (edited) return current;
  const next = row.plan ? prefill(row) : current;
  if (row.plan && (row.operationId || !row.blocks?.some((block) => block.code === "scope_changed"))) return next;
  return { ...next, write: row.requested_scope === "dml" || row.requested_scope === "migration", migrations: row.requested_scope === "migration" };
}

export function normalizeForm(f: ProvisionForm): ProvisionForm {
  return Object.fromEntries(Object.entries(f).map(([key, value]) =>
    [key, typeof value === "string" ? value.trim() : value])) as unknown as ProvisionForm;
}

export function selectCandidate(f: ProvisionForm, c: DbCandidate): ProvisionForm {
  return normalizeForm({ ...f, candidateId: c.id, server: c.server,
    container: c.container, engine: c.engine, db: c.db || f.db, sshAlias: "" });
}

export function candidateLabel(c: DbCandidate): string {
  return [c.name, c.environment || "environment unknown", c.server, c.applicationName || c.application].filter(Boolean).join(" · ");
}

export function targetBlocks(blocks: DbRequestBlock[], candidate?: DbCandidate): DbRequestBlock[] {
  if (!candidate) return blocks;
  return blocks.filter((b) => b.code !== "target_choice" &&
    (!b.candidateId || b.candidateId === candidate.id) &&
    (!b.instance || !candidate.instance || b.instance === candidate.instance));
}

export function formProblems(input: ProvisionForm): string[] {
  const f = normalizeForm(input);
  const problems: string[] = [];
  for (const [key, value] of Object.entries({ server: f.server, container: f.container, db: f.db, roUser: f.roUser, opItem: f.opItem,
    ...(f.write ? { rwUser: f.rwUser, rwOpItem: f.rwOpItem } : {}) })) {
    if (!value) problems.push(`Missing ${key}.`);
  }
  if (f.server && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(f.server)) problems.push("Server must be a catalog identifier.");
  if (f.container && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(f.container)) problems.push("Container identifier contains invalid characters.");
  for (const [key, value] of Object.entries({ db: f.db, roUser: f.roUser, ...(f.write ? { rwUser: f.rwUser } : {}) })) {
    if (value && !/^[a-z_][a-z0-9_]{0,62}$/.test(value)) problems.push(`${key} contains invalid characters.`);
  }
  if (!["postgres", "mysql"].includes(f.engine)) problems.push("Choose PostgreSQL or MySQL.");
  if (f.hostPort !== 0 && (!Number.isInteger(f.hostPort) || f.hostPort < 1024 || f.hostPort > 65535)) {
    problems.push("Host port must be Auto or a whole number between 1024 and 65535.");
  }
  return problems;
}

export function formReady(f: ProvisionForm): { ok: true } | { ok: false; problem: string } {
  const problems = formProblems(f);
  return problems.length ? { ok: false, problem: problems.join(" ") } : { ok: true };
}

export function requestState(r: DbRequestRow): string {
  // Old approval was a manual attestation. Never present it as verified access.
  return r.state || (r.status === "approved" ? "verification_required" : r.status);
}

export function stateLabel(r: DbRequestRow): string {
  const state = requestState(r);
  return ({ pending: "Target needed", preparing: "Checking setup", blocked: "Action needed",
    awaiting_approval: "Waiting for your approval", executing: "Setting up on host", verifying: "Verifying access",
    ready: "Access verified", rejected: "Rejected", failed: "Setup failed",
    verification_required: "Verification required" } as Record<string, string>)[state] || state;
}

export function canApprove(r: DbRequestRow, dirty = false): boolean {
  return requestState(r) === "awaiting_approval" && !!r.operationId && !!r.plan && !r.blocks?.length && !dirty;
}

export function mergeBlocks(...groups: (DbRequestBlock[] | undefined)[]): DbRequestBlock[] {
  return [...new Map(groups.flatMap((group) => group ?? []).map((b) => [blockKey(b), b])).values()];
}

export function blockKey(b: DbRequestBlock): string {
  return JSON.stringify([b.code, b.message, b.instance ?? null, b.candidateId ?? null]);
}
