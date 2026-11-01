import { parseDeviceAuth, parseLoginStatus, readVolumeFile, type CodexAuthDeps } from "./agentAuth";
import { parseCodexAuthJson } from "./codexUsageFetch";

export const CODEX_PROFILE_ROOT = "/home/dev/.codex-accounts";
export class CodexProfileInUseError extends Error {
  constructor() {
    super("This GPT account is mounted by a container. Stop and remove containers using it before deleting the account.");
    this.name = "CodexProfileInUseError";
  }
}
const AUTH_PATH = "/home/dev/.codex/auth.json";
const FILE_STORE = 'cli_auth_credentials_store="file"';
const LOGIN_LABEL = "devbox.codex-account-login";
type LoginStatus = "pending" | "done" | "error";
type Attempt = { status: "starting" | LoginStatus; busy: boolean };
// Scope state to the injected Docker runner, so separate hosts/test fixtures do
// not share attempts. The Docker volume/container checks also survive restart.
const attemptsByRunner = new WeakMap<CodexAuthDeps["run"], Map<string, Attempt>>();

function attempts(d: CodexAuthDeps): Map<string, Attempt> {
  let map = attemptsByRunner.get(d.run);
  if (!map) { map = new Map(); attemptsByRunner.set(d.run, map); }
  return map;
}

function assertId(id: string): void {
  if (typeof id !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) {
    throw new Error("Invalid GPT account ID.");
  }
}

function assertNewAccount(id: string): void {
  assertId(id);
  if (id === "default") throw new Error("The default GPT account cannot be changed this way.");
}

export function codexAccountVolume(id: string): string {
  assertId(id);
  return id === "default" ? "codex-home" : `codex-acct-${id}`;
}

/** Invalid persisted IDs must not turn into Docker arguments or mount paths. */
export function codexAccountMountList(ids: string[]): string[] {
  return [...new Set(ids)].filter(id => id !== "default" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(id))
    .map(id => `${codexAccountVolume(id)}:${CODEX_PROFILE_ROOT}/${id}`);
}

function containerName(id: string): string { return `devbox-codex-login-${id}`; }
function img(d: CodexAuthDeps): string { return d.image ?? "devbox:latest"; }

// Listing distinguishes a missing volume from an unavailable Docker daemon,
// without depending on localized stderr or accidentally creating it by reading.
async function volumeExists(d: CodexAuthDeps, volume: string): Promise<boolean> {
  const result = await d.run(["volume", "ls", "--filter", `name=${volume}`, "--format", "{{.Name}}"]);
  if (result.code !== 0) throw new Error("Could not verify the GPT account profile.");
  return result.stdout.split(/\r?\n/).some(name => name.trim() === volume);
}

async function stopContainer(d: CodexAuthDeps, id: string): Promise<void> {
  const result = await d.run(["rm", "-f", containerName(id)]);
  if (result.code !== 0) {
    // A missing container is already stopped. Other failures must not be hidden.
    const remaining = await d.run(["ps", "-a", "--filter", `name=^/${containerName(id)}$`, "--format", "{{.Names}}"]);
    if (remaining.code !== 0 || remaining.stdout.trim() !== "") throw new Error("Could not stop the GPT account login.");
  }
}

async function bestEffortStop(d: CodexAuthDeps, id: string): Promise<void> {
  try { await stopContainer(d, id); } catch { /* Caller still reports failure; never expose Docker output. */ }
}

/** Only new, empty profiles can be enrolled. Reauthentication must be explicit
 *  elsewhere; rerunning Add may never overwrite an existing account's auth. */
export async function startAccountLogin(d: CodexAuthDeps, id: string): Promise<{ url: string; code: string; expiresInSec: number }> {
  assertNewAccount(id);
  const map = attempts(d);
  if (map.has(id)) throw new Error("A login for this GPT account has already been started.");
  const attempt: Attempt = { status: "starting", busy: true };
  map.set(id, attempt); // Reserve synchronously, before the first Docker await.
  let ownsContainer = false;
  try {
    const volume = codexAccountVolume(id);
    if (await volumeExists(d, volume)) throw new Error("The GPT account profile already exists.");
    const existing = await d.run(["ps", "-a", "--filter", `name=^/${containerName(id)}$`, "--format", "{{.Names}}"]);
    if (existing.code !== 0 || existing.stdout.trim() !== "") throw new Error("A GPT account login is already in progress or unavailable.");
    const created = await d.run(["volume", "create", volume]);
    if (created.code !== 0) throw new Error("Could not create the GPT account profile.");
    // No Docker copy-up: the profile starts empty even when the image contains
    // a default auth/config. Initialize owner because named volumes start as root.
    const initialized = await d.run(["run", "--rm", "-u", "0", "--mount",
      `type=volume,source=${volume},target=/profile,volume-nocopy`, img(d), "sh", "-c",
      'test -z "$(ls -A /profile)" && chown 1000:1000 /profile && chmod 700 /profile']);
    if (initialized.code !== 0) throw new Error("The GPT account profile is not empty or cannot be prepared.");
    ownsContainer = true; // Also clean up if the runner throws after Docker starts.
    const started = await d.run(["run", "-d", "--name", containerName(id), "--label", `${LOGIN_LABEL}=${id}`,
      "--mount", `type=volume,source=${volume},target=/home/dev/.codex,volume-nocopy`,
      "-e", "CODEX_HOME=/home/dev/.codex", img(d), "codex", "-c", FILE_STORE, "login", "--device-auth"]);
    // Failed docker run can still have created a stopped container.
    if (started.code !== 0) throw new Error("Could not start the GPT account login.");
    for (let poll = 0; poll < 15; poll++) {
      await d.sleep(500);
      const logs = await d.run(["logs", containerName(id)]);
      if (logs.code !== 0) throw new Error("Could not read the GPT account login code.");
      const parsed = parseDeviceAuth(`${logs.stdout}\n${logs.stderr}`);
      if (parsed) {
        attempt.status = "pending";
        return { ...parsed, expiresInSec: 900 };
      }
    }
    throw new Error("The GPT account login code was not available in time.");
  } catch {
    attempt.status = "error";
    if (ownsContainer) await bestEffortStop(d, id);
    // Only fixed messages generated here are safe; runner exceptions may include
    // arbitrary command output, including credentials. Keep the public error generic.
    throw new Error("Could not start the GPT account login; the profile may already exist.");
  } finally {
    attempt.busy = false;
  }
}

/** Reading an auth blob is internal-only. Errors never contain Docker stderr. */
export async function readAccountAuth(d: CodexAuthDeps, id: string): Promise<{ raw: string | null; dockerError: string | null }> {
  const volume = codexAccountVolume(id);
  try {
    if (!await volumeExists(d, volume)) return { raw: null, dockerError: null };
    const result = await readVolumeFile({ ...d, run: cmd => {
      const readonly = [...cmd];
      const mount = readonly.indexOf("-v") + 1;
      // Even the legacy default auth is only mounted for reading here. nocopy
      // also prevents Docker from seeding an empty profile from the image.
      readonly[mount] += ":ro,nocopy";
      return d.run(readonly);
    } }, volume, AUTH_PATH);
    return result.dockerError ? { raw: null, dockerError: "Could not read the GPT account login." } : result;
  } catch {
    return { raw: null, dockerError: "Could not read the GPT account login." };
  }
}

export async function accountLoginStatus(d: CodexAuthDeps, id: string): Promise<LoginStatus> {
  assertNewAccount(id);
  const map = attempts(d);
  const known = map.get(id);
  if (known?.busy || known?.status === "starting") return "pending";
  if (known?.status === "done" || known?.status === "error") return known.status;
  const attempt: Attempt = known ?? { status: "pending", busy: false };
  map.set(id, attempt);
  attempt.busy = true;
  try {
    const inspect = await d.run(["inspect", "-f", "{{json .State}}", containerName(id)]);
    let state: { Status?: string; ExitCode?: number } | null = null;
    if (inspect.code === 0) {
      try { state = JSON.parse(inspect.stdout); } catch { /* Malformed state is an error. */ }
    }
    if (state?.Status === "running" || state?.Status === "created") return "pending";
    // Crucially, auth.json alone never completes an attempt: the actual login
    // process must have finished successfully, including after a devd restart.
    if (state?.Status === "exited" && state.ExitCode === 0) {
      const auth = await readAccountAuth(d, id);
      const tokens = auth.raw ? parseCodexAuthJson(auth.raw) : null;
      if (tokens?.accessToken.trim() && !auth.dockerError) {
        const status = await d.run(["run", "--rm", "-v", `${codexAccountVolume(id)}:/home/dev/.codex`,
          "-e", "CODEX_HOME=/home/dev/.codex", img(d), "codex", "-c", FILE_STORE, "login", "status"]);
        if (status.code === 0 && parseLoginStatus(`${status.stdout}\n${status.stderr}`)) attempt.status = "done";
      }
    }
    if (attempt.status !== "done") attempt.status = "error";
    await bestEffortStop(d, id);
    return attempt.status;
  } catch {
    attempt.status = "error";
    await bestEffortStop(d, id);
    return "error";
  } finally {
    attempt.busy = false;
  }
}

/** Stops the login; it does not erase a credential file that may just have been
 *  written. Remove the unregistered profile explicitly when abandoning Add. */
export async function cancelAccountLogin(d: CodexAuthDeps, id: string): Promise<void> {
  assertNewAccount(id);
  const map = attempts(d);
  if (map.get(id)?.busy) throw new Error("A GPT account operation is already in progress.");
  const attempt: Attempt = { status: "error", busy: true };
  map.set(id, attempt);
  try { await stopContainer(d, id); }
  catch { throw new Error("Could not stop the GPT account login."); }
  finally { attempt.busy = false; }
}

/** Never purge mounted credentials: a selected session may still use them. */
export async function removeAccountProfile(d: CodexAuthDeps, id: string): Promise<void> {
  assertNewAccount(id);
  const map = attempts(d);
  if (map.get(id)?.busy) throw new Error("A GPT account operation is already in progress.");
  const attempt: Attempt = { status: "error", busy: true };
  map.set(id, attempt);
  try {
    const volume = codexAccountVolume(id);
    if (!await volumeExists(d, volume)) { map.delete(id); return; }
    const refs = await d.run(["ps", "-a", "--filter", `volume=${volume}`, "--format", "{{.Names}}"]);
    if (refs.code !== 0) throw new Error("Could not verify usage of the GPT account profile.");
    if (refs.stdout.trim() !== "") throw new CodexProfileInUseError();
    const removed = await d.run(["volume", "rm", volume]);
    if (removed.code !== 0) throw new Error("Could not remove the GPT account profile.");
    map.delete(id);
  } catch (error) {
    if (error instanceof CodexProfileInUseError) throw error;
    throw new Error("Could not safely remove the GPT account profile.");
  } finally {
    attempt.busy = false;
  }
}

/** Copy only credentials, atomically, after the service checked the identity.
 * Existing history/config/SQLite and the mounted volume are left intact. */
export async function installAccountAuth(d: CodexAuthDeps, sourceId: string, targetId: string): Promise<void> {
  assertNewAccount(sourceId);
  const source = codexAccountVolume(sourceId), target = codexAccountVolume(targetId);
  if (source === target || !await volumeExists(d, source) || !await volumeExists(d, target))
    throw new Error("The existing account profile is unavailable.");
  const result = await d.run(["run", "--rm", "-u", "1000:1000",
    "--mount", `type=volume,source=${source},target=/source,readonly,volume-nocopy`,
    "--mount", `type=volume,source=${target},target=/target,volume-nocopy`,
    img(d), "python3", "-c", [
      "import os, tempfile",
      "data = open('/source/auth.json', 'rb').read()",
      "fd, path = tempfile.mkstemp(prefix='.reauth-', dir='/target')",
      "try:",
      "    with os.fdopen(fd, 'wb') as f:",
      "        f.write(data)",
      "        f.flush()",
      "        os.fsync(f.fileno())",
      "    os.replace(path, '/target/auth.json')",
      "finally:",
      "    if os.path.exists(path): os.unlink(path)",
    ].join("\n")]);
  if (result.code !== 0) throw new Error("Could not save the account sign-in.");
}
