/** Opt-in real PostgreSQL test. A task-owned local test server must be started
 * first; no production URLs, credentials or default application DB are accepted.
 * DEVD_TEST_PG_PORT=... bun test devd/test/dbOnboardingPostgres.integration.test.ts */
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { onboardingRoleSql, onboardingVerifySql, onboardingWriteVerifySql } from "../src/dbOnboardingScripts";
import type { OnboardingPlan } from "../src/dbOnboarding";

const port = Number(process.env.DEVD_TEST_PG_PORT || 0);
const integration = port ? test : test.skip;
integration("real PostgreSQL: retry-safe roles, read-only denial, DML-only denial, explicit owner migration, new-table grants", async () => {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid isolated fixture port");
  const base = `devd_qa_${randomBytes(4).toString("hex")}`;
  const owner = `${base}_owner`; const ro = `${base}_ro`; const rw = `${base}_rw`; const migration = `${base}_migration`;
  const admin = postgres({ host: "/tmp", port, database: "postgres", username: "fixture_admin", max: 1, prepare: false, onnotice: () => {} });
  const conns: ReturnType<typeof postgres>[] = [];
  let created = false;
  try {
    const identity = await admin`SELECT current_user`;
    expect(identity[0]?.current_user).toBe("fixture_admin");
    await admin.unsafe(`CREATE ROLE ${owner} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;`);
    await admin.unsafe(`CREATE DATABASE ${base} OWNER ${owner};`);
    created = true;
    const setup = postgres({ host: "/tmp", port, database: base, username: "fixture_admin", max: 1, prepare: false, onnotice: () => {} }); conns.push(setup);
    await setup.unsafe(`CREATE TABLE public.invoices(id integer PRIMARY KEY, amount integer); ALTER TABLE public.invoices OWNER TO ${owner}; INSERT INTO invoices VALUES (1,100);`);
    const entry = { name: base, server: "isolated", engine: "postgres" as const, hostPort: port, db: base, roUser: ro, opItem: `test ${ro}`, rwUser: rw, rwOpItem: `test ${rw}`, migrationUser: migration, migrationOpItem: `test ${migration}` };
    const server = { host: "127.0.0.1", port: 22, user: "devbox-db-tunnel", key: "prod-tunnel-isolated" };
    const plan: OnboardingPlan = { requestId: 1, entry, server, trustedServer: server, input: { ...entry, sshAlias: "not-used", container: "isolated" }, write: true, migrations: true, changes: [], fingerprint: "isolated" };
    const passwords = { [ro]: "test-ro-secret", [rw]: "test-rw-secret", [migration]: "test-migration-secret" };
    // Even with a human-approved migration mode, onboarding must not grant a
    // production superuser membership; a failed setup must roll roles back.
    await setup.unsafe(`ALTER DATABASE ${base} OWNER TO fixture_admin;`);
    await expect(Promise.resolve(setup.unsafe(onboardingRoleSql(plan, passwords)))).rejects.toMatchObject({ code: "P0001" });
    await setup.unsafe("ROLLBACK;");
    expect((await setup`SELECT 1 FROM pg_roles WHERE rolname=${ro}`).length).toBe(0);
    await setup.unsafe(`ALTER DATABASE ${base} OWNER TO ${owner};`);
    await setup.unsafe(onboardingRoleSql(plan, passwords));
    await setup.unsafe(onboardingRoleSql(plan, passwords));
    const connect = (role: string) => { const sql = postgres({ host: "127.0.0.1", port, database: base, username: role, password: passwords[role], max: 1, prepare: false, onnotice: () => {} }); conns.push(sql); return sql; };
    const roSql = connect(ro); const rwSql = connect(rw); const migrationSql = connect(migration);
    expect((await roSql.unsafe(onboardingVerifySql(plan)))[0]?.verified).toBe(true);
    expect((await rwSql.unsafe(onboardingWriteVerifySql(plan, rw, false)))[0]?.verified).toBe(true);
    expect((await migrationSql.unsafe(onboardingWriteVerifySql(plan, migration, true)))[0]?.verified).toBe(true);
    expect((await roSql`SELECT amount FROM invoices WHERE id=1`)[0]?.amount).toBe(100);
    await expect(Promise.resolve(roSql`UPDATE invoices SET amount=200 WHERE id=1`)).rejects.toMatchObject({ code: "25006" });
    await roSql`SET default_transaction_read_only=off`;
    await expect(Promise.resolve(roSql`UPDATE invoices SET amount=200 WHERE id=1`)).rejects.toMatchObject({ code: "42501" });
    await rwSql`UPDATE invoices SET amount=150 WHERE id=1`;
    await expect(Promise.resolve(rwSql`ALTER TABLE invoices ADD COLUMN cash_reserve_amount numeric`)).rejects.toMatchObject({ code: "42501" });
    await migrationSql.begin(async tx => { await tx.unsafe("ALTER TABLE invoices ADD COLUMN cash_reserve_amount numeric; CREATE TABLE cash_deposits(id integer PRIMARY KEY, amount numeric);"); });
    expect((await roSql`SELECT cash_reserve_amount FROM invoices WHERE id=1`)[0]?.cash_reserve_amount).toBeNull();
    expect(await roSql`SELECT * FROM cash_deposits`).toHaveLength(0);
    await rwSql`INSERT INTO cash_deposits VALUES (1,25)`;
    expect((await roSql`SELECT amount FROM cash_deposits WHERE id=1`)[0]?.amount).toBe("25");
    await setup.unsafe(onboardingRoleSql(plan, passwords)); // retry after migration-owned objects exist
    await roSql`SET default_transaction_read_only=on`;
    expect((await roSql.unsafe(onboardingVerifySql(plan)))[0]?.verified).toBe(true);
    await setup.unsafe("CREATE FUNCTION public.unsafe_writer() RETURNS void LANGUAGE sql SECURITY DEFINER AS $$ UPDATE invoices SET amount=999 WHERE id=1 $$;");
    expect((await roSql.unsafe(onboardingVerifySql(plan)))[0]?.verified).toBe(false);
    await setup.unsafe("DROP FUNCTION public.unsafe_writer();");
  } finally {
    await Promise.all(conns.map(c => c.end({ timeout: 2 })));
    if (created) await admin.unsafe(`DROP DATABASE ${base};`);
    await admin.unsafe(`DROP ROLE IF EXISTS ${migration},${rw},${ro},${owner};`);
    await admin.end({ timeout: 2 });
  }
}, 30_000);
