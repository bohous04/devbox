import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SEED = join(import.meta.dir, "..", "..", "image", "seed-agy-hooks.sh");

function fakeExec(dir: string, name: string): string {
  const p = join(dir, name); writeFileSync(p, "#!/usr/bin/env bash\nexit 0\n"); chmodSync(p, 0o755); return p;
}
async function seed(home: string) {
  const p = Bun.spawn(["bash", SEED], {
    env: { ...process.env, HOME: home, AGY_CONFIG: join(home, ".gemini", "config"), AGY_HOOK: fakeExec(home, "agy-hook.sh") },
    stdout: "ignore", stderr: "pipe",
  });
  const err = await new Response(p.stderr).text();
  return { code: await p.exited, err };
}
const FILE = (home: string) => join(home, ".gemini", "config", "hooks.json");
const read = (home: string) => JSON.parse(readFileSync(FILE(home), "utf8"));

test("writes a named devd hook with flat SessionStart/PreInvocation/Stop", async () => {
  const home = mkdtempSync(join(tmpdir(), "agys-"));
  expect((await seed(home)).code).toBe(0);
  const devd = read(home).devd;
  expect(Object.keys(devd).sort()).toEqual(["PreInvocation", "SessionStart", "Stop"]);
  expect(devd.Stop[0].timeout).toBe(300);
  for (const ev of ["SessionStart", "PreInvocation", "Stop"]) {
    expect(devd[ev][0].type).toBe("command");
    // guard for older images without the adapter: the command still prints valid JSON
    expect(devd[ev][0].command).toContain("|| echo '{}'");
    expect(devd[ev][0].command).toContain(ev);
  }
});

test("never registers PreToolUse (an empty response would disable tools)", async () => {
  const home = mkdtempSync(join(tmpdir(), "agys-"));
  await seed(home);
  expect(JSON.stringify(read(home))).not.toContain("PreToolUse");
});

test("foreign named hooks stay, repeated seeding is idempotent", async () => {
  const home = mkdtempSync(join(tmpdir(), "agys-"));
  mkdirSync(join(home, ".gemini", "config"), { recursive: true });
  const mine = { PostToolUse: [{ matcher: "run_command", hooks: [{ command: "./lint.sh" }] }] };
  writeFileSync(FILE(home), JSON.stringify({ "lint-checker": mine }));
  await seed(home); const first = read(home);
  await seed(home); const second = read(home);
  expect(first["lint-checker"]).toEqual(mine);
  expect(second).toEqual(first);
});

test("leaves a broken hooks.json alone and says so on stderr", async () => {
  const home = mkdtempSync(join(tmpdir(), "agys-"));
  mkdirSync(join(home, ".gemini", "config"), { recursive: true });
  writeFileSync(FILE(home), "{broken");
  const r = await seed(home);
  expect(r.code).toBe(0);
  expect(readFileSync(FILE(home), "utf8")).toBe("{broken");
  expect(r.err).toContain("hooks.json");
});
