import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { databaseCandidateInspectionScript } from "../src/dbOnboardingHost";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test("runtime discovery returns only a validated database name and rejects unsafe or contradictory metadata", () => {
  const dir = mkdtempSync(join(tmpdir(), "db-metadata-")); dirs.push(dir);
  writeFileSync(join(dir, "docker"), '#!/usr/bin/env python3\nimport os,sys\nassert sys.argv[1:]==["inspect","--","pg-fixture"]\nprint(os.environ["DEVD_TEST_INSPECT"])\n');
  chmodSync(join(dir, "docker"), 0o755);
  const base = { Name: "/pg-fixture", State: { Running: true }, Config: { Image: "postgres:16-alpine", Env: ["POSTGRES_DB=workflow", "POSTGRES_PASSWORD=NEVER_RETURN"] } };
  const run = (value: unknown, engine: "postgres" | "mariadb" = "postgres") => Bun.spawnSync(["bash", "-c", databaseCandidateInspectionScript("pg-fixture", engine)], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, DEVD_TEST_INSPECT: JSON.stringify([value]) },
  });
  const valid = run(base);
  expect(valid.exitCode).toBe(0); expect(JSON.parse(valid.stdout.toString())).toEqual({ db: "workflow" });
  expect(valid.stdout.toString()).not.toContain("NEVER_RETURN");
  for (const bad of [{ ...base, Name: "/other-container" }, { ...base, State: { Running: false } }, { ...base, Config: { ...base.Config, Image: "mysql:8" } }, { ...base, Config: { ...base.Config, Env: ["POSTGRES_DB=bad;command"] } }, { ...base, Config: { ...base.Config, Env: ["POSTGRES_PASSWORD=NEVER_RETURN"] } }]) {
    const result = run(bad); expect(result.exitCode).not.toBe(0);
    expect(result.stdout.toString() + result.stderr.toString()).not.toContain("NEVER_RETURN");
  }
  const conflicting = run({ ...base, Config: { Image: "mariadb:11", Env: ["MARIADB_DATABASE=one", "MYSQL_DATABASE=other"] } }, "mariadb");
  expect(conflicting.exitCode).not.toBe(0);
  expect(() => databaseCandidateInspectionScript("pg; echo unsafe", "postgres")).toThrow();
});
