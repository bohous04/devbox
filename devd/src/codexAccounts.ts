import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import type { CodexAuthDeps } from "./agentAuth";
import { buildCodexView, codexUsageView, pollCodex, type CodexView } from "./codexPoller";
import { parseCodexAuthJson } from "./codexUsageFetch";
import { codexPreference, getCodexAccount, initCodexAccounts, listCodexAccounts, storedCodexAccountUsage } from "./codexAccountsDb";
import { accountLoginStatus, installAccountAuth, cancelAccountLogin, codexAccountVolume, CodexProfileInUseError, readAccountAuth, removeAccountProfile, startAccountLogin } from "./codexAccountProfiles";

export interface CodexAccountView {
  id: string; label: string; isDefault: boolean; disabled: boolean; usage: CodexView | null;
  sharedUsageWith: string[];
}
export interface CodexAccountsDeps {
  db: Database; auth: CodexAuthDeps; fetch: typeof fetch; now?: () => number;
  // Live login of the main account from the Codex server on the host (see codexServerAuth.ts);
  // null = the server has none of its own → the volume is read.
  readServerAuth?: () => Promise<string | null>;
}
class AccountError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 | 502 = 400) { super(message); }
}

// Deterministic launch selection; running agents keep their existing account.
export function chooseCodexAccount(accounts: CodexAccountView[], preferred: string | null, now: number): CodexAccountView | null {
  const usable = accounts.filter(a => !a.disabled && a.usage?.state !== "signed-out"
    && !(a.usage?.state === "error" && /HTTP (401|402|403)|deactivated|invalid_grant/i.test(a.usage.error ?? "")));
  if (preferred !== null) return usable.find(a => a.id === preferred) ?? null;
  const score = (a: CodexAccountView): number => {
    const measured = a.usage?.windows.filter(w => w.usedPct !== null) ?? [];
    const score = measured.length ? Math.max(...measured.map(w => w.resetsAt !== null && w.resetsAt <= now ? 0 : w.usedPct!)) : 50;
    const liveLimit = a.usage?.limitReached && (!measured.length || measured.some(w => w.resetsAt === null || w.resetsAt > now));
    return liveLimit ? Math.max(100, score) : score;
  };
  return usable.sort((a, b) => score(a) - score(b) || Number(b.isDefault) - Number(a.isDefault) || a.id.localeCompare(b.id))[0] ?? null;
}

export class CodexAccounts {
  private running = new Map<string, Promise<unknown>>();
  // Live credential identity can change outside the dashboard, especially for the legacy profile.
  private observedIdentities = new Map<string, string | null>();
  private now: () => number;
  constructor(private d: CodexAccountsDeps) { initCodexAccounts(d.db); this.now = d.now ?? Date.now; }

  private require(id: string) {
    const row = getCodexAccount(this.d.db, id);
    if (!row) throw new AccountError("Unknown Codex account.", 404);
    return row;
  }
  private async exclusive<T>(id: string, action: () => Promise<T>): Promise<T> {
    if (this.running.has(id)) throw new AccountError("This account is busy. Try again shortly.", 409);
    const pending = Promise.resolve().then(action);
    this.running.set(id, pending);
    try { return await pending; } finally { this.running.delete(id); }
  }
  list() {
    const rows = listCodexAccounts(this.d.db).filter(a => a.status === "ready");
    const identity = (a: typeof rows[number]) => this.observedIdentities.has(a.id) ? this.observedIdentities.get(a.id) : a.identity;
    return {
      accounts: rows.map(a => ({
        sharedUsageWith: identity(a) ? rows.filter(other => other.id !== a.id && identity(other) === identity(a)).map(other => other.label) : [],
        id: a.id, label: a.label, isDefault: a.id === "default", disabled: a.disabled === 1,
        usage: a.id === "default" ? buildCodexView(this.d.db) : codexUsageView(storedCodexAccountUsage(this.d.db, a.id)),
      })),
      preferredAccountId: codexPreference(this.d.db),
    };
  }
  async start(label: unknown) {
    if (typeof label !== "string" || !label.trim() || label.trim().length > 100)
      throw new AccountError("Enter an account name (1–100 characters).");
    if (listCodexAccounts(this.d.db).filter(a => a.status === "pending").length >= 4)
      throw new AccountError("Finish or cancel an existing sign-in first.", 409);
    const id = crypto.randomUUID();
    this.d.db.query("INSERT INTO codex_accounts (id,label,status,added_at) VALUES (?,?,'pending',?)").run(id, label.trim(), this.now());
    try { return { id, ...await this.exclusive(id, () => startAccountLogin(this.d.auth, id)) }; }
    catch {
      this.d.db.query("UPDATE codex_accounts SET status='error' WHERE id=?").run(id);
      // Retain a failed profile until cleanup succeeds; the periodic poll retries.
      try { await removeAccountProfile(this.d.auth, id); this.d.db.query("DELETE FROM codex_accounts WHERE id=?").run(id); } catch { /* retry on poll */ }
      throw new AccountError("Could not start ChatGPT sign-in. Please try again.", 502);
    }
  }
  private reauth(id: string) {
    return this.d.db.query("SELECT * FROM codex_account_reauth WHERE account_id=?").get(id) as
      { account_id: string; attempt_id: string; identity: string | null; started_at: number; status: string; error: string | null } | null;
  }
  private async cleanReauth(id: string) {
    const attempt = this.reauth(id);
    if (!attempt?.attempt_id) return;
    await cancelAccountLogin(this.d.auth, attempt.attempt_id);
    await removeAccountProfile(this.d.auth, attempt.attempt_id);
    this.d.db.query("UPDATE codex_account_reauth SET attempt_id='' WHERE account_id=?").run(id);
  }
  async reauthStart(id: string) {
    const row = this.require(id);
    if (row.status !== "ready") throw new AccountError("Complete the initial sign-in first.");
    return this.exclusive(id, async () => {
      const previous = this.reauth(id);
      if (previous?.status === "pending" && this.now() - previous.started_at < 900_000)
        throw new AccountError("Sign-in is already in progress. Finish or cancel it first.", 409);
      await this.cleanReauth(id);
      const current = await readAccountAuth(this.d.auth, id);
      if (current.dockerError) throw new AccountError("Could not check the existing profile.", 502);
      const identity = row.identity ?? (current.raw ? parseCodexAuthJson(current.raw)?.accountId : null);
      if (!identity) throw new AccountError("The original account identity is unavailable. Cannot safely reconnect this profile.", 409);
      const attemptId = crypto.randomUUID();
      this.d.db.query("INSERT OR REPLACE INTO codex_account_reauth (account_id,attempt_id,identity,started_at,status) VALUES (?,?,?,?,'pending')")
        .run(id, attemptId, identity, this.now());
      try { return { id, ...await startAccountLogin(this.d.auth, attemptId) }; }
      catch {
        this.d.db.query("UPDATE codex_account_reauth SET status='error',error=? WHERE account_id=?")
          .run("Could not start sign-in. Try again.", id);
        try { await this.cleanReauth(id); } catch { /* periodic cleanup retries */ }
        throw new AccountError("Could not start ChatGPT sign-in. Try again.", 502);
      }
    });
  }
  async reauthStatus(id: string): Promise<{ status: "pending" | "done" | "error"; error?: string }> {
    this.require(id);
    const result = await this.exclusive(id, async () => {
      const attempt = this.reauth(id);
      if (!attempt) return { status: "error" as const, error: "No sign-in is in progress. Start again." };
      if (attempt.status !== "pending") return { status: attempt.status as "done" | "error", ...(attempt.error ? { error: attempt.error } : {}) };
      const expired = this.now() - attempt.started_at >= 900_000;
      const status = expired ? "error" : await accountLoginStatus(this.d.auth, attempt.attempt_id);
      if (status === "pending") return { status };
      let error = status === "error" ? "Sign-in expired or failed. Try again." : null;
      if (!error) {
        const auth = await readAccountAuth(this.d.auth, attempt.attempt_id);
        if (auth.dockerError) throw new AccountError("Could not verify sign-in. Retrying is safe.", 502);
        const identity = auth.raw ? parseCodexAuthJson(auth.raw)?.accountId : null;
        if (!identity || identity !== attempt.identity) error = "You signed in with a different ChatGPT account. Use the account belonging to this profile.";
        else await installAccountAuth(this.d.auth, attempt.attempt_id, id);
      }
      const finalStatus = error ? "error" : "done";
      this.d.db.query("UPDATE codex_account_reauth SET status=?,error=? WHERE account_id=?").run(finalStatus, error, id);
      try { await this.cleanReauth(id); } catch { /* periodic cleanup retries */ }
      return { status: finalStatus as "done" | "error", ...(error ? { error } : {}) };
    });
    if (result.status === "done") await this.refresh(id);
    return result;
  }
  async reauthCancel(id: string) {
    this.require(id);
    await this.exclusive(id, async () => {
      this.d.db.query("UPDATE codex_account_reauth SET status='error',error='Sign-in cancelled.' WHERE account_id=? AND status='pending'").run(id);
      await this.cleanReauth(id);
    });
    return { ok: true };
  }
  async loginStatus(id: string): Promise<{ status: "pending" | "done" | "error"; error?: string }> {
    const row = this.require(id);
    if (row.status === "ready") return { status: "done" };
    if (row.status === "error") return { status: "error", error: "Sign-in failed or expired. Add the account again." };
    const result = await this.exclusive(id, async (): Promise<{ status: "pending" | "done" | "error"; error?: string }> => {
      if (this.now() - row.added_at > 900_000) {
        await cancelAccountLogin(this.d.auth, id);
        this.d.db.query("UPDATE codex_accounts SET status='error' WHERE id=?").run(id);
        return { status: "error", error: "Sign-in expired. Add the account again." };
      }
      const status = await accountLoginStatus(this.d.auth, id);
      if (status !== "done") {
        if (status === "error") this.d.db.query("UPDATE codex_accounts SET status='error' WHERE id=?").run(id);
        return { status };
      }
      const { raw } = await readAccountAuth(this.d.auth, id);
      const tokens = raw === null ? null : parseCodexAuthJson(raw);
      if (!tokens?.accountId) throw new AccountError("The signed-in ChatGPT account could not be identified.", 502);
      // Legacy account was not registered by this service: learn its identity
      // without moving or modifying its credentials.
      const primary = await readAccountAuth(this.d.auth, "default");
      if (primary.dockerError) throw new AccountError("Could not check the existing account. Try again shortly.", 502);
      const primaryId = primary.raw === null ? null : parseCodexAuthJson(primary.raw)?.accountId;
      const duplicate = primaryId === tokens.accountId || listCodexAccounts(this.d.db).some(a => a.id !== id && a.identity === tokens.accountId);
      if (duplicate) {
        this.d.db.query("UPDATE codex_accounts SET status='error' WHERE id=?").run(id);
        return { status: "error", error: "This ChatGPT account is already connected. Sign in with a different account." };
      }
      this.d.db.query("UPDATE codex_accounts SET status='ready',identity=? WHERE id=?").run(tokens.accountId, id);
      return { status: "done" };
    });
    if (result.status === "done") void this.refresh(id).catch(() => {});
    return result;
  }
  async remove(id: string) {
    this.require(id);
    if (id === "default") throw new AccountError("The main account cannot be removed.");
    await this.exclusive(id, async () => {
      await this.cleanReauth(id);
      await cancelAccountLogin(this.d.auth, id);
      await removeAccountProfile(this.d.auth, id);
      this.d.db.transaction(() => {
        this.d.db.query("UPDATE codex_account_settings SET preferred_account_id=NULL WHERE preferred_account_id=?").run(id);
        this.d.db.query("DELETE FROM codex_accounts WHERE id=?").run(id);
        this.d.db.query("DELETE FROM codex_account_reauth WHERE account_id=?").run(id);
      })();
    });
    return { ok: true };
  }
  update(id: string, body: { label?: unknown; disabled?: unknown } | null) {
    const row = this.require(id);
    if (!body || (body.label === undefined && body.disabled === undefined)) throw new AccountError("Provide a name or enabled state.");
    if (body.label !== undefined && (typeof body.label !== "string" || !body.label.trim() || body.label.trim().length > 100)) throw new AccountError("Invalid account name.");
    if (body.disabled !== undefined && typeof body.disabled !== "boolean") throw new AccountError("disabled must be a boolean.");
    this.d.db.query("UPDATE codex_accounts SET label=?,disabled=? WHERE id=?")
      .run(typeof body.label === "string" ? body.label.trim() : row.label, typeof body.disabled === "boolean" ? Number(body.disabled) : row.disabled, id);
    if (body.disabled === true) this.d.db.query("UPDATE codex_account_settings SET preferred_account_id=NULL WHERE preferred_account_id=?").run(id);
    return { ok: true };
  }
  preference(id: unknown) {
    if (id !== null) {
      if (typeof id !== "string") throw new AccountError("Select an account or automatic selection.");
      const row = this.require(id);
      if (row.disabled || row.status !== "ready") throw new AccountError("Enable and sign in to this account first.");
    }
    this.d.db.query("UPDATE codex_account_settings SET preferred_account_id=? WHERE singleton=1").run(id as string | null);
    return { ok: true };
  }
  select(available?: string[]) {
    const { accounts, preferredAccountId } = this.list();
    const candidates = available ? accounts.filter(a => available.includes(a.id)) : accounts;
    const account = chooseCodexAccount(candidates, preferredAccountId, this.now());
    if (!account) throw new AccountError("No enabled Codex account is available in this session. Reopen the session after adding an account.", 409);
    return { accountId: account.id, label: account.label };
  }
  async refresh(id: string, force = true) {
    const row = this.require(id);
    if (row.status !== "ready") throw new AccountError("Complete sign-in first.");
    if (this.running.has(id)) { await this.running.get(id); return; }
    await this.exclusive(id, async () => {
      await pollCodex({
        db: this.d.db, ...this.d.auth, fetch: this.d.fetch, now: this.now, force, accountId: id, accountLabel: row.label,
        volume: codexAccountVolume(id),
        readAuth: async () => {
          const server = id === "default" && this.d.readServerAuth ? await this.d.readServerAuth() : null;
          const auth = server !== null ? { raw: server, dockerError: null } : await readAccountAuth(this.d.auth, id);
          if (!auth.dockerError) this.observedIdentities.set(id, auth.raw ? parseCodexAuthJson(auth.raw)?.accountId ?? null : null);
          return auth;
        },
        ...(id === "default" ? {} : { store: {
          get: () => storedCodexAccountUsage(this.d.db, id),
          put: (usage: import("./db").CodexUsageRow) => { this.d.db.query("UPDATE codex_accounts SET usage_json=? WHERE id=?").run(JSON.stringify(usage), id); },
        } }),
      });
    });
  }
  async poll() {
    for (const row of listCodexAccounts(this.d.db)) {
      try {
        const attempt = this.reauth(row.id);
        if (attempt?.status === "pending") await this.reauthStatus(row.id);
        else if (attempt) await this.exclusive(row.id, () => this.cleanReauth(row.id));
        if (row.status === "ready") await this.refresh(row.id, false);
        else if (row.status === "pending") await this.loginStatus(row.id);
        else await this.remove(row.id);
      } catch { /* One unavailable profile must not block the others. */ }
    }
  }
}

export function codexAccountsRoutes(service?: CodexAccounts) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    if (!service) return c.json({ error: "Codex accounts are not configured." }, 503);
    await next();
  });
  app.onError((e, c) => c.json({ error: e instanceof AccountError || e instanceof CodexProfileInUseError ? e.message : "The Codex account operation failed. Please try again." }, e instanceof AccountError ? e.status : e instanceof CodexProfileInUseError ? 409 : 502));
  app.get("/", c => c.json(service!.list()));
  app.post("/login/start", async c => c.json(await service!.start((await c.req.json().catch(() => null))?.label)));
  app.get("/select", c => c.json(service!.select(c.req.query("available")?.split(","))));
  app.post("/preference", async c => c.json(service!.preference((await c.req.json().catch(() => null))?.accountId)));
  app.post("/:id/reauth/start", async c => c.json(await service!.reauthStart(c.req.param("id"))));
  app.get("/:id/reauth/status", async c => c.json(await service!.reauthStatus(c.req.param("id"))));
  app.post("/:id/reauth/cancel", async c => c.json(await service!.reauthCancel(c.req.param("id"))));
  app.get("/:id/login/status", async c => c.json(await service!.loginStatus(c.req.param("id"))));
  app.post("/:id/login/cancel", async c => c.json(await service!.remove(c.req.param("id"))));
  app.post("/:id/refresh", async c => {
    await service!.refresh(c.req.param("id"));
    return c.json({ account: service!.list().accounts.find(a => a.id === c.req.param("id")) });
  });
  app.patch("/:id", async c => c.json(service!.update(c.req.param("id"), await c.req.json().catch(() => null))));
  app.delete("/:id", async c => c.json(await service!.remove(c.req.param("id"))));
  return app;
}
