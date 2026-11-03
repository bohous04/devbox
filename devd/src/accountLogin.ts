import { parseAuthStatus } from "./accountProfiles";
import { randomUUID } from "node:crypto";
import { isValidClaudeCode, parseClaudeLoginUrl, type CodexAuthDeps } from "./agentAuth";

const EXIT = "/tmp/account-login.exit";
export type LoginStatus = "pending" | "done" | "error";

/** One isolated login at a time. Tokens stay in container tmpfs until registered server-side.
 * The timer finishes/cleans up even after the browser closes. No shared profile is mounted. */
export class AccountLogin {
  private job?: { id: string; container: string; status: LoginStatus; timer?: ReturnType<typeof setTimeout> };
  private working = false;
  constructor(private d: CodexAuthDeps, private save: (id: string, credentials: string, label?: string) => Promise<void>) {}

  async start(id: string): Promise<{ url: string }> {
    if (this.job?.status === "pending") throw new Error("An account login is already running. Finish or cancel it first.");
    const container = `devbox-account-login-${randomUUID()}`;
    const job = this.job = { id, container, status: "pending" as LoginStatus, timer: undefined as ReturnType<typeof setTimeout> | undefined };
    try {
      const r = await this.d.run(["run", "-d", "--rm", "--name", container,
        "--tmpfs", "/home/dev/.claude:uid=1000,gid=1000,mode=700",
        "-e", "CLAUDE_CONFIG_DIR=/home/dev/.claude", "-e", "BROWSER=true", "-e", "TERM=xterm-256color",
        this.d.image ?? "devbox:latest", "sh", "-c",
        `tmux new-session -d -x 1000 -y 50 'claude auth login --claudeai; echo $? > ${EXIT}'; exec sleep 900`]);
      if (r.code !== 0) throw new Error("Could not start the account login session.");
      for (let i = 0; i < 30; i++) {
        await this.d.sleep(500);
        const pane = await this.d.run(["exec", container, "tmux", "capture-pane", "-pJ", "-S", "-"]);
        const url = parseClaudeLoginUrl(pane.stdout);
        if (url) { this.schedule(job); return { url }; }
      }
      throw new Error("Could not read the account login URL. Try again.");
    } catch (e) { job.status = "error"; await this.cleanup(job); throw e; }
  }

  private schedule(job: NonNullable<AccountLogin["job"]>) {
    job.timer = setTimeout(async () => {
      try { await this.status(job.id); } catch { job.status = "error"; await this.cleanup(job); }
      if (job.status === "pending") this.schedule(job);
    }, 2000);
    job.timer.unref?.();
  }

  private async cleanup(job: NonNullable<AccountLogin["job"]>) {
    clearTimeout(job.timer);
    await this.d.run(["rm", "-f", job.container]);
  }

  async code(id: string, code: string) {
    const job = this.job;
    if (!job || job.id !== id || job.status !== "pending") throw new Error("Start the account login again.");
    if (!isValidClaudeCode(code)) throw new Error("Invalid authorization code.");
    const r = await this.d.run(["exec", "-i", job.container, "sh", "-c", 'tmux send-keys -l -- "$(cat)"; tmux send-keys Enter'], code);
    if (r.code !== 0) throw new Error("Login session is no longer running.");
  }

  async status(id: string): Promise<LoginStatus> {
    const job = this.job;
    if (!job || job.id !== id) return "error";
    if (job.status !== "pending" || this.working) return job.status;
    this.working = true;
    try {
      const exit = await this.d.run(["exec", job.container, "cat", EXIT]);
      if (exit.code === 0 && exit.stdout.trim() !== "") {
        if (exit.stdout.trim() !== "0") throw new Error("Login failed.");
        const creds = await this.d.run(["exec", job.container, "cat", "/home/dev/.claude/.credentials.json"]);
        if (creds.code !== 0 || !creds.stdout.trim()) throw new Error("Login did not save credentials.");
        const identity = await this.d.run(["exec", job.container, "claude", "auth", "status"]);
        const ident = parseAuthStatus(identity.stdout);
        const label = ident.email ? (ident.orgName ? `${ident.email} (${ident.orgName})` : ident.email) : undefined;
        await this.save(id, creds.stdout, label);
        job.status = "done";
        await this.cleanup(job);
      } else {
        const state = await this.d.run(["inspect", "-f", "{{.State.Running}}", job.container]);
        if (state.code !== 0 || state.stdout.trim() !== "true") throw new Error("Login session expired.");
      }
    } catch { job.status = "error"; await this.cleanup(job); }
    finally { this.working = false; }
    return job.status;
  }

  async cancel(id: string) {
    const job = this.job;
    if (!job || job.id !== id || job.status !== "pending") return;
    if (this.working) throw new Error("Login is being saved. Try again shortly.");
    job.status = "error";
    await this.cleanup(job);
  }
}
