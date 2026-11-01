import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TRUST = join(import.meta.dir, "..", "..", "image", "agy-trust");

function setup() {
  const home = mkdtempSync(join(tmpdir(), "agy-"));
  const agyHome = join(home, ".gemini", "antigravity-cli");
  const ws = realpathSync(mkdtempSync(join(tmpdir(), "ws-")));
  return { home, agyHome, ws, settings: join(agyHome, "settings.json") };
}
async function trust(agyHome: string, dir: string) {
  const p = Bun.spawn(["python3", TRUST, dir], { env: { ...process.env, AGY_HOME: agyHome }, stdout: "pipe", stderr: "pipe" });
  return { code: await p.exited, err: await new Response(p.stderr).text() };
}

test("adds the path to an empty home and the file has mode 600", async () => {
  const t = setup();
  expect((await trust(t.agyHome, t.ws)).code).toBe(0);
  expect(JSON.parse(readFileSync(t.settings, "utf8")).trustedWorkspaces).toEqual([t.ws]);
  expect(statSync(t.settings).mode & 0o777).toBe(0o600);
});

test("keeps foreign keys and adds no duplicate", async () => {
  const t = setup();
  mkdirSync(t.agyHome, { recursive: true });
  writeFileSync(t.settings, JSON.stringify({ theme: "dark", trustedWorkspaces: [t.ws] }));
  expect((await trust(t.agyHome, t.ws)).code).toBe(0);
  expect(JSON.parse(readFileSync(t.settings, "utf8"))).toEqual({ theme: "dark", trustedWorkspaces: [t.ws] });
});

test("20 concurrent starts — no path gets lost", async () => {
  const t = setup();
  const dirs = Array.from({ length: 20 }, () => realpathSync(mkdtempSync(join(tmpdir(), "ws-"))));
  const codes = await Promise.all(dirs.map((d) => trust(t.agyHome, d).then((r) => r.code)));
  expect(codes.every((c) => c === 0)).toBe(true);
  const got = JSON.parse(readFileSync(t.settings, "utf8")).trustedWorkspaces as string[];
  expect([...got].sort()).toEqual([...dirs].sort());
});

test("an unreadable settings.json is left alone, exit 1 and one sentence on stderr", async () => {
  const t = setup();
  mkdirSync(t.agyHome, { recursive: true });
  writeFileSync(t.settings, "{not json");
  const r = await trust(t.agyHome, t.ws);
  expect(r.code).toBe(1);
  expect(readFileSync(t.settings, "utf8")).toBe("{not json");
  expect(r.err).toContain("settings.json");
});

test("no argument exits 2", async () => {
  const p = Bun.spawn(["python3", TRUST], { stdout: "ignore", stderr: "ignore" });
  expect(await p.exited).toBe(2);
});
