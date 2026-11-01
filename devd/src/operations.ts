// The catalog is the ONLY truth about what the agent may run through the broker. Anything not here
// is rejected — and so an operation with a free-form command in a parameter must never appear here.
// That would degrade the broker into simply handing out a credential and the whole phase would lose its point.
// This is guarded by the test "no catalog entry has a free-form command parameter".
export interface ParamDef { required: boolean; oneOf?: string[]; pattern?: RegExp }

export interface OperationDef {
  /** Short description for the approval screen — read by a person, not a machine. */
  summary: string;
  params: Record<string, ParamDef>;
  /** Whether the operation requires a separate manual approval. */
  needsApproval: boolean;
}

/** Projects whose application the agent may restart. Per installation via
 *  DEVD_RESTART_PROJECTS (comma-separated); empty = restart is allowed for no project.
 *  The array is only mutated in place (setRestartProjects), because the catalog holds it by reference. */
const PROJECTS: string[] = [];

export function setRestartProjects(list: string[]): void {
  PROJECTS.splice(0, PROJECTS.length, ...list.map((p) => p.trim()).filter(Boolean));
}
setRestartProjects((process.env.DEVD_RESTART_PROJECTS ?? "").split(","));

export const OPERATIONS: Record<string, OperationDef> = {
  deploy: {
    summary: "Deploy a project through Coolify",
    params: {
      project: { required: false, pattern: /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/ },
      instance: { required: false, pattern: /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/ },
      application: { required: false, pattern: /^[A-Za-z0-9]{1,128}$/ },
      commit: { required: false, pattern: /^[a-f0-9]{40}$/ },
      afterWrite: { required: false, pattern: /^[1-9][0-9]*$/ },
      idempotencyKey: { required: false, pattern: /^[A-Za-z0-9._:-]{1,128}$/ },
    },
    needsApproval: false,
  },
  "restart-app": {
    summary: "Restart a project's application in Coolify",
    params: { project: { required: true, oneOf: PROJECTS } },
    needsApproval: true,
  },
};

export type Validated =
  | { ok: true; params: Record<string, string> }
  | { ok: false; error: string };

// The catalog can be swapped in — so tests can also verify validation that no real operation uses.
export function validateParams(
  op: string, params: Record<string, unknown>, catalog: Record<string, OperationDef> = OPERATIONS,
): Validated {
  const def = catalog[op];
  if (!def) return { ok: false, error: `unknown operation: ${op}` };
  const out: Record<string, string> = {};
  for (const [name, p] of Object.entries(def.params)) {
    const v = typeof params[name] === "string" ? (params[name] as string).trim() : params[name];
    if (v === undefined || v === "") {
      if (p.required) return { ok: false, error: `missing parameter ${name}` };
      continue;
    }
    if (typeof v !== "string") return { ok: false, error: `${name} must be a string` };
    if (p.oneOf && !p.oneOf.includes(v)) return { ok: false, error: `${name}: value not allowed` };
    if (p.pattern && !p.pattern.test(v)) return { ok: false, error: `${name}: invalid format` };
    out[name] = v;   // only known parameters — anything extra does not get in here
  }
  if (catalog === OPERATIONS && op === "deploy") {
    if (!out.project && !(out.instance && out.application)) return { ok: false, error: "missing project or instance + application" };
    if ((out.instance || out.application) && !(out.instance && out.application)) return { ok: false, error: "instance and application must be given together" };
  }
  return { ok: true, params: out };
}
