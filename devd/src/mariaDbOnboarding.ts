import { createHash } from "node:crypto";
import { createConnection } from "mysql2/promise";
import type { OnboardingPlan } from "./dbOnboarding";
import { mysqlPasswordHash } from "./mysqlAuth";
const q = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
const lit = (s: string) => "'" + s.replaceAll("\\", "\\\\").replaceAll("'", "''") + "'";
const ident = (s: string) => "`" + s.replaceAll("`", "``") + "`";
const roles = (p: OnboardingPlan) => [p.entry.roUser, p.entry.rwUser, p.entry.migrationUser].filter((r): r is string => !!r);
const marker = (p: OnboardingPlan, user: string) => {
  const item = user === p.entry.roUser ? p.entry.opItem : user === p.entry.rwUser ? p.entry.rwOpItem : p.entry.migrationOpItem;
  return createHash("sha256").update(JSON.stringify([p.entry.server, p.entry.container, p.entry.db, user, item])).digest("hex");
};
const ledger = (p: OnboardingPlan, user: string) => "/var/lib/devd-db-roles/" + marker(p, user);

/** Admin credentials are resolved inside the container, never returned to devd. */
export function mariaAdminCommand(p: OnboardingPlan): string {
  return ["set -eu", "client=$(command -v mariadb || command -v mysql)",
    'password=${MARIADB_ROOT_PASSWORD:-${MYSQL_ROOT_PASSWORD:-}}',
    'file=${MARIADB_ROOT_PASSWORD_FILE:-${MYSQL_ROOT_PASSWORD_FILE:-}}',
    'if [ -n "$file" ]; then password=$(cat "$file"); fi', 'export MYSQL_PWD="$password"',
    'exec "$client" --protocol=socket --user=root --batch --raw --skip-column-names --database=' + q(p.entry.db)].join("\n");
}
export function mariaInspectionCommand(p: OnboardingPlan): string {
  const checks = roles(p).map(user => "WHEN User=" + lit(user) + " AND Host='%' THEN IF('$MANAGED_" + user + "'='yes',TRUE,FALSE)").join(" ");
  const sql = "SELECT JSON_OBJECT('db',DATABASE(),'owner','root','ownerSafe',TRUE,'ownerOwnsTables',TRUE," +
    "'publicReadOnlySafe', NOT EXISTS(SELECT 1 FROM mysql.user WHERE User='PUBLIC')," +
    "'roles',COALESCE((SELECT JSON_ARRAYAGG(JSON_OBJECT('name',CONCAT(User,'@',Host),'managed',CASE " + checks +
    " ELSE FALSE END)) FROM mysql.user WHERE User IN (" + roles(p).map(lit).join(",") + ")),JSON_ARRAY()));";
  const tests = roles(p).map(user => ["MANAGED_" + user + "=no",
    "if [ ! -L " + q(ledger(p,user)) + ' ] && [ "$(cat ' + q(ledger(p,user)) + ' 2>/dev/null)" = ' + q(marker(p,user)) + " ]; then MANAGED_" + user + "=yes; fi"].join("\n")).join("\n");
  return tests + "\nprintf 'DATABASE='; docker exec -i " + q(p.input.container) + " sh -c " + q(mariaAdminCommand(p)) +
    " <<DEVD_INSPECT_SQL 2>/dev/null || echo null\n" + sql + "\nDEVD_INSPECT_SQL";
}
export function mariaPrivileges(p: OnboardingPlan, user: string): string[] {
  if (user === p.entry.roUser) return ["SELECT"];
  const dml = ["SELECT", "INSERT", "UPDATE", "DELETE"];
  return user === p.entry.migrationUser ? [...dml, "CREATE", "DROP", "REFERENCES", "INDEX", "ALTER", "CREATE VIEW", "SHOW VIEW"] : dml;
}
/** Account DDL implicitly commits. Hash + host ledger identify retry ownership.
 * `accountHost` is '%' behind the loopback relay; a direct (internet-reachable)
 * server binds the account to devd's egress IP instead. */
export function mariaRoleSql(p: OnboardingPlan, user: string, password: string, accountHost = "%"): string {
  if (!roles(p).includes(user) || !password) throw Error("invalid managed role");
  if (!/^[0-9a-fA-F.:%]{1,45}$/.test(accountHost)) throw Error("invalid account host");
  const account = lit(user) + "@" + lit(accountHost), hash = mysqlPasswordHash(password);
  const schema = ident(p.entry.db.replaceAll("_", "\\_").replaceAll("%", "\\%"));
  return ["BEGIN NOT ATOMIC",
    "IF EXISTS(SELECT 1 FROM mysql.user WHERE User=" + lit(user) + " AND (Host<>" + lit(accountHost) + " OR plugin<>'mysql_native_password' OR authentication_string<>" + lit(hash) + "))",
    " OR EXISTS(SELECT 1 FROM mysql.roles_mapping WHERE User=" + lit(user) + ") THEN",
    " SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='devd role_conflict';", "END IF;",
    "IF NOT EXISTS(SELECT 1 FROM mysql.user WHERE User=" + lit(user) + " AND Host=" + lit(accountHost) + ") THEN",
    " CREATE USER " + account + " IDENTIFIED VIA mysql_native_password USING " + lit(hash) + ";", "END IF;",
    "REVOKE ALL PRIVILEGES, GRANT OPTION FROM " + account + ";",
    "GRANT " + mariaPrivileges(p,user).join(", ") + " ON " + schema + ".* TO " + account + ";", "END"].join("\n");
}
export function mariaRoleScript(p: OnboardingPlan, passwords: Record<string,string>): string {
  const exec = "docker exec -i " + q(p.input.container) + " sh -c " + q(mariaAdminCommand(p));
  const statements = roles(p).map(user => {
    const file = q(ledger(p,user)), mark = q(marker(p,user));
    return ["existing=$(" + exec + " <<'DEVD_LOOKUP'", "SELECT COUNT(*) FROM mysql.user WHERE User=" + lit(user) + ";", "DEVD_LOOKUP", ")",
      'if [ "$existing" != 0 ]; then',
      "  [ ! -L " + file + ' ] && [ "$(cat ' + file + ' 2>/dev/null)" = ' + mark + " ] || { echo BLOCK:role_conflict; exit 1; }", "else",
      "  [ ! -L " + file + " ] || { echo BLOCK:role_conflict; exit 1; }", "  printf '%s' " + mark + " > " + file, "fi",
      exec + " <<'DEVD_ROLE_SQL'", "DELIMITER //", mariaRoleSql(p,user,passwords[user]!) + "//", "DEVD_ROLE_SQL"].join("\n");
  }).join("\n");
  return ["set -eu", '[ "$(id -u)" = 0 ] || { echo BLOCK:admin_privileges; exit 1; }', "umask 077",
    "exec 9>/run/lock/devd-db-onboarding.lock", "flock -x 9",
    "[ ! -L /var/lib/devd-db-roles ] || { echo BLOCK:role_conflict; exit 1; }",
    "install -d -o root -g root -m 0700 /var/lib/devd-db-roles", statements, ""].join("\n");
}
export async function verifyMariaRole(p: OnboardingPlan, user: string, password: string, port: number, at: { host?: string; accountHost?: string } = {}): Promise<void> {
  const c = await createConnection({ host: at.host ?? "127.0.0.1", port, user, password, database: p.entry.db, connectTimeout: 10000 });
  try {
    const [identity] = await c.query<any[]>("SELECT CURRENT_USER() AS account, DATABASE() AS db, CURRENT_ROLE() AS role");
    if (identity[0]?.account !== user + "@" + (at.accountHost ?? "%") || identity[0]?.db !== p.entry.db || identity[0]?.role !== null) throw Error("role identity mismatch");
    const [rows] = await c.query<any[]>("SHOW GRANTS FOR CURRENT_USER");
    const expected = mariaPrivileges(p,user).sort().join(",");
    const schema = ident(p.entry.db.replaceAll("_", "\\_").replaceAll("%", "\\%"));
    let found = false;
    for (const row of rows) {
      const line = String(Object.values(row)[0]);
      if (/^GRANT USAGE ON \*\.\* TO /.test(line) && !line.includes("WITH GRANT OPTION")) continue;
      const match = /^GRANT (.+) ON (.+) TO /.exec(line);
      if (!match || match[2] !== schema + ".*" || match[1]!.split(/,\s*/).sort().join(",") !== expected || line.includes("WITH GRANT OPTION")) throw Error("unexpected role privileges");
      found = true;
    }
    if (!found) throw Error("missing database grant");
  } finally { await c.end(); }
}
