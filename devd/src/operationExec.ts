import { CoolifyError, coolifyJson, type CoolifyInstance } from "./coolify";

export type OperationStage = "target_validation" | "target_verification" | "commit_pin" | "commit_verification" | "queue" | "deployment_verification";
export interface SafeOperationError {
  code: string;
  category: "configuration" | "connection" | "permission" | "decision";
  message: string;
  stage?: OperationStage;
  deploymentId?: string;
}
/** Only locally constructed failures may cross the API boundary. Never retain causes/bodies. */
class OperationError extends Error {
  constructor(readonly details: SafeOperationError) { super(details.message); this.name = "OperationError"; }
}
function failure(code: string, category: SafeOperationError["category"], message: string): OperationError {
  return new OperationError({ code, category, message });
}
export function safeOperationError(error: unknown): SafeOperationError {
  if (error instanceof OperationError) return { ...error.details };
  // coolifyJson already replaces HTTP response bodies and transport errors with safe text.
  if (error instanceof CoolifyError) return { code: error.code, category: error.category, message: error.message };
  return { code: "operation_failed", category: "connection", message: "The operation could not be completed. Check its status and that the host configuration is available." };
}
function atStage(error: unknown, stage: OperationStage, deploymentId?: string): OperationError {
  const safe = safeOperationError(error);
  if (stage === "queue" && safe.category === "connection" && safe.code !== "deployment_queue_unverified") {
    safe.message += " The outcome of the sent request is unknown; do not repeat the deploy without checking the queue.";
  }
  return new OperationError({ ...safe, stage, ...(deploymentId ? { deploymentId } : {}) });
}

// Credentials are resolved on the host only, at preparation/execution time.
export interface CoolifyCfg { url: string; token: string; apps: Record<string, string>; headers?: Record<string, string> }
export interface OperationExecDeps {
  coolify: () => CoolifyCfg | undefined;
  coolifyInstances?: () => Record<string, CoolifyInstance>;
  fetch?: (req: Request) => Promise<Response>;
}
export interface PreparedCoolifyDeployment {
  project: string; application: string; instance?: string; commit?: string; previousCommit?: string; changes: string[];
}
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
function trimmed(params: Record<string, string>) { return Object.fromEntries(Object.entries(params).map(([k, v]) => [k, v.trim()])); }
function target(d: OperationExecDeps, params: Record<string, string>) {
  const project = params.project ?? "", name = params.instance || params.server;
  if (name) {
    const inst = d.coolifyInstances?.()[name];
    if (!inst) throw failure("coolify_instance_missing", "configuration", `Coolify instance ${name} is not in the host configuration.`);
    if (!params.application || !ID.test(params.application)) throw failure("application_invalid", "configuration", "A valid UUID of a specific Coolify application is missing.");
    return { inst, application: params.application, project: project || params.application, instance: name };
  }
  const cfg = d.coolify();
  if (!cfg) throw failure("coolify_credentials_missing", "configuration", "Coolify credentials are unavailable — is the vault unlocked?");
  const application = cfg.apps[project];
  if (!application) throw failure("application_mapping_missing", "configuration", `project ${project} has no Coolify application in the configuration`);
  if (!ID.test(application) || params.application && params.application !== application) throw failure("application_mismatch", "configuration", "The application UUID does not match the project configuration.");
  return { inst: { name: "configured", url: cfg.url, token: cfg.token, headers: cfg.headers ?? {} }, application, project, instance: undefined };
}
async function readApplication(d: OperationExecDeps, t: ReturnType<typeof target>) {
  const value = await coolifyJson(t.inst, `/applications/${encodeURIComponent(t.application)}`, d.fetch);
  if (!value || typeof value !== "object" || Array.isArray(value) || (value as { uuid?: unknown }).uuid !== t.application) throw failure("application_unverified", "connection", "Coolify did not confirm the requested application UUID.");
  const sha = (value as { git_commit_sha?: unknown }).git_commit_sha;
  return { commit: typeof sha === "string" && sha.trim() ? sha.trim() : "HEAD" };
}

/** Read-only preparation. Pinning the application is an explicit part of approval. */
export async function prepareCoolifyDeployment(d: OperationExecDeps, input: Record<string, string>): Promise<PreparedCoolifyDeployment> {
  let stage: OperationStage = "target_validation";
  try {
    const params = trimmed(input), t = target(d, params);
    if (params.commit && !SHA.test(params.commit)) throw failure("commit_invalid", "configuration", "A deploy requires a full Git commit SHA (40 or 64 hex characters).");
    stage = "target_verification";
    const app = await readApplication(d, t);
    return {
      project: t.project, application: t.application, ...(t.instance ? { instance: t.instance } : {}),
      ...(params.commit ? { commit: params.commit.toLowerCase(), previousCommit: app.commit } : {}),
      changes: [
        ...(params.commit && app.commit.toLowerCase() !== params.commit.toLowerCase() ? [`Pin application ${t.application} to commit ${params.commit.toLowerCase()} (currently ${app.commit}). The pin stays in place for subsequent deploys.`] : []),
        `Queue application ${t.application} in the regular Coolify deploy queue via POST /api/v1/deploy.`,
      ],
    };
  } catch (error) { throw atStage(error, stage); }
}

export function createOperationExec(d: OperationExecDeps) {
  const inFlight = new Map<string, Promise<unknown>>();
  async function runOperation(op: string, input: Record<string, string>): Promise<string> {
    let stage: OperationStage = "target_validation", deploymentId: string | undefined;
    try {
      if (op !== "deploy" && op !== "restart-app") throw failure("operation_unsupported", "configuration", `operation ${op} has no implementation`);
      const params = trimmed(input), t = target(d, params);
      if (op === "restart-app" && params.commit) throw failure("restart_commit_unsupported", "configuration", "An application restart does not accept a commit change; prepare a deploy.");
      if (params.commit && !SHA.test(params.commit)) throw failure("commit_invalid", "configuration", "A deploy requires a full Git commit SHA (40 or 64 hex characters).");
      if (params.commit && !params.previousCommit) throw failure("deployment_plan_missing", "decision", "The prepared commit change range is missing; first prepare a deploy for approval.");
      // Read the exact application again, so a removed target or config drift fails before mutation.
      stage = "target_verification";
      const app = await readApplication(d, t);
      if (params.commit) {
        const commit = params.commit.toLowerCase();
        if (app.commit.toLowerCase() !== commit) {
          if (app.commit !== params.previousCommit) throw failure("deployment_plan_stale", "decision", "The commit configuration changed since approval; prepare a new deploy plan.");
          // /deploy has no commit parameter. Persist the approved pin before queueing; do not
          // restore it silently: the approved plan explicitly records persistent pinning.
          stage = "commit_pin";
          await coolifyJson(t.inst, `/applications/${encodeURIComponent(t.application)}`, d.fetch, {
            method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ git_commit_sha: commit }),
          });
          stage = "commit_verification";
          if ((await readApplication(d, t)).commit.toLowerCase() !== commit) throw failure("commit_pin_unverified", "connection", "Coolify did not confirm pinning the approved commit; the deploy was not started.");
        }
      }
      stage = "queue";
      const value = await coolifyJson(t.inst, op === "deploy" ? "/deploy" : `/applications/${encodeURIComponent(t.application)}/restart`, d.fetch, {
        method: "POST", headers: { "content-type": "application/json" }, ...(op === "deploy" ? { body: JSON.stringify({ uuid: t.application }) } : {}),
      });
      const result = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
      const rows = Array.isArray(result.deployments) ? result.deployments : [];
      const deployment = op === "deploy" ? rows.find((row) => row && typeof row === "object" && row.resource_uuid === t.application)?.deployment_uuid : result.deployment_uuid;
      if (typeof deployment !== "string" || !ID.test(deployment)) throw failure("deployment_queue_unverified", "connection", "Coolify did not confirm queueing the application (deployment UUID missing); check the permissions and the queue status. The outcome of the sent request is unknown; do not repeat the deploy without checking the queue.");
      deploymentId = deployment;
      if (params.commit) {
        stage = "deployment_verification";
        const queued = await coolifyJson(t.inst, `/deployments/${encodeURIComponent(deployment)}`, d.fetch);
        const queuedCommit = queued && typeof queued === "object" && !Array.isArray(queued) ? (queued as { commit?: unknown }).commit : undefined;
        if (typeof queuedCommit !== "string" || queuedCommit.toLowerCase() !== params.commit.toLowerCase()) throw failure("deployment_commit_unverified", "decision", `Coolify queued deployment ${deployment} but did not confirm the approved commit; check the queue before continuing.`);
      }
      return `${op === "deploy" ? "deploy" : "restart"} ${t.project} queued; application=${t.application}; deployment=${deployment}${params.commit ? `; commit=${params.commit.toLowerCase()}` : ""}. Verify completion and application health by the deployment ID.`;
    } catch (error) { throw atStage(error, stage, deploymentId); }
  }
  return function execOperation(op: string, input: Record<string, string>): Promise<string> {
    if (op !== "deploy" && op !== "restart-app") return Promise.reject(atStage(failure("operation_unsupported", "configuration", `operation ${op} has no implementation`), "target_validation"));
    let key: string;
    try { const t = target(d, trimmed(input)); key = `${t.inst.url}:${t.application}`; }
    catch (error) { return Promise.reject(atStage(error, "target_validation")); }
    const pending = (inFlight.get(key) ?? Promise.resolve()).catch(() => {}).then(() => runOperation(op, input));
    inFlight.set(key, pending);
    void pending.finally(() => { if (inFlight.get(key) === pending) inFlight.delete(key); }).catch(() => {});
    return pending;
  };
}
