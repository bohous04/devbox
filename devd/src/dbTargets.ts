import { mysqlResponse } from "./mysqlAuth";
import { timingSafeEqual, randomBytes } from "node:crypto";
import type { DbEntry } from "./prodDb";

// The dummy has the shape of ordinary credentials, but is valid only inside this process and only for
// the session it was issued to. The name carries the database so the log can be read without looking it up.
export interface Target { entry: DbEntry; session: string }

export interface DbTargets {
  issue(session: string, db: string): { user: string; password: string };
  resolve(user: string): Target | undefined;
  revoke(session: string): void;
  authenticateMysql(user: string, salt: Buffer, response: Buffer): Target | undefined;
}

export function createDbTargets(d: { entries: () => DbEntry[] }): DbTargets {
  const byUser = new Map<string, Target>();
  const passwords = new Map<string, string>();
  return {
    issue(session, db) {
      const entry = d.entries().find((e) => e.name === db);
      if (!entry) throw new Error(`unknown database: ${db}`);
      const user = `devbox_${db}_${randomBytes(6).toString("hex")}`;
      byUser.set(user, { entry, session });
      // The proxy never verifies the dummy's password — the client sends it, the proxy discards it and
      // authenticates itself. It is random only so that it cannot be guessed outside this process.
      const password = randomBytes(18).toString("base64url");
      passwords.set(user, password);
      return { user, password };
    },
    resolve: (user) => byUser.get(user),
    authenticateMysql(user, salt, response) {
      const password = passwords.get(user), target = byUser.get(user);
      if (!password || !target || target.entry.engine !== "mariadb") return;
      const expected = mysqlResponse(password, salt);
      return response.length === expected.length && timingSafeEqual(response, expected) ? target : undefined;
    },
    revoke(session) {
      for (const [k, v] of byUser) if (v.session === session) { byUser.delete(k); passwords.delete(k); }
    },
  };
}
