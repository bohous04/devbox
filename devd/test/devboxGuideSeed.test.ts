import { expect, test } from "bun:test";
import { join } from "node:path";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const SEED = join(import.meta.dir, "..", "..", "image", "seed-devbox-guide.sh");

async function seed(env: Record<string, string>) {
  const p = Bun.spawn(["bash", SEED], { env: { ...process.env, ...env }, stdout: "ignore", stderr: "ignore" });
  return await p.exited;
}
function tmp() { return mkdtempSync(join(tmpdir(), "devboxguide-")); }
const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;

test("empty state → creates CLAUDE.md with one block", async () => {
  const dir = tmp();
  const guide = join(dir, "guide.md");
  writeFileSync(guide, "# Devbox\nuse `srv`\n");
  const code = await seed({ CLAUDE_CONFIG_DIR: dir, DEVBOX_GUIDE: guide, HOME: dir });
  expect(code).toBe(0);
  const md = readFileSync(join(dir, "CLAUDE.md"), "utf8");
  expect(md).toContain("<!-- BEGIN devbox-guide -->");
  expect(md).toContain("<!-- END devbox-guide -->");
  expect(md).toContain("use `srv`");
  expect(count(md, /BEGIN devbox-guide/g)).toBe(1);
  rmSync(dir, { recursive: true, force: true });
});

test("re-run does not duplicate the block", async () => {
  const dir = tmp();
  const guide = join(dir, "guide.md");
  writeFileSync(guide, "GUIDE-V1\n");
  await seed({ CLAUDE_CONFIG_DIR: dir, DEVBOX_GUIDE: guide, HOME: dir });
  await seed({ CLAUDE_CONFIG_DIR: dir, DEVBOX_GUIDE: guide, HOME: dir });
  const md = readFileSync(join(dir, "CLAUDE.md"), "utf8");
  expect(count(md, /BEGIN devbox-guide/g)).toBe(1);
  expect(count(md, /GUIDE-V1/g)).toBe(1);
  rmSync(dir, { recursive: true, force: true });
});

test("keeps user content, block placed first", async () => {
  const dir = tmp();
  const guide = join(dir, "guide.md");
  writeFileSync(guide, "GUIDE\n");
  writeFileSync(join(dir, "CLAUDE.md"), "MY NOTES\n");
  await seed({ CLAUDE_CONFIG_DIR: dir, DEVBOX_GUIDE: guide, HOME: dir });
  const md = readFileSync(join(dir, "CLAUDE.md"), "utf8");
  expect(md).toContain("MY NOTES");
  expect(md.indexOf("BEGIN devbox-guide")).toBeLessThan(md.indexOf("MY NOTES"));
  rmSync(dir, { recursive: true, force: true });
});

test("a guide.md update propagates, user content unchanged", async () => {
  const dir = tmp();
  const guide = join(dir, "guide.md");
  writeFileSync(guide, "GUIDE-V1\n");
  writeFileSync(join(dir, "CLAUDE.md"), "MY NOTES\n");
  await seed({ CLAUDE_CONFIG_DIR: dir, DEVBOX_GUIDE: guide, HOME: dir });
  writeFileSync(guide, "GUIDE-V2\n");
  await seed({ CLAUDE_CONFIG_DIR: dir, DEVBOX_GUIDE: guide, HOME: dir });
  const md = readFileSync(join(dir, "CLAUDE.md"), "utf8");
  expect(md).toContain("GUIDE-V2");
  expect(md).not.toContain("GUIDE-V1");
  expect(md).toContain("MY NOTES");
  expect(count(md, /BEGIN devbox-guide/g)).toBe(1);
  rmSync(dir, { recursive: true, force: true });
});

test("missing guide → no-op, CLAUDE.md is not created", async () => {
  const dir = tmp();
  const code = await seed({ CLAUDE_CONFIG_DIR: dir, DEVBOX_GUIDE: join(dir, "nope.md"), HOME: dir });
  expect(code).toBe(0);
  expect(existsSync(join(dir, "CLAUDE.md"))).toBe(false);
  expect(existsSync(join(dir, ".codex", "AGENTS.md"))).toBe(false);
  rmSync(dir, { recursive: true, force: true });
});

test("real devbox-guide.md → the block contains tool names", async () => {
  const dir = tmp();
  const guide = join(import.meta.dir, "..", "..", "image", "devbox-guide.md");
  const code = await seed({ CLAUDE_CONFIG_DIR: dir, DEVBOX_GUIDE: guide, HOME: dir });
  expect(code).toBe(0);
  const md = readFileSync(join(dir, "CLAUDE.md"), "utf8");
  // `prod-db write` is here on purpose: without it the agent reads only "writes are
  // refused" from the manual and suggests the user run the write by hand (regression before 2026-07-26).
  for (const t of ["srv", "open <file>", "preview", "prod-db write", "VPS"]) expect(md).toContain(t);
  expect(count(md, /BEGIN devbox-guide/g)).toBe(1);
  rmSync(dir, { recursive: true, force: true });
});

// --- Codex target (AGENTS.md) ------------------------------------------------
// Codex does not read CLAUDE.md; without its own AGENTS.md it would not know about srv/open/preview/prod-db.

test("also seeds Codex AGENTS.md, with the same block as CLAUDE.md", async () => {
  const dir = tmp();
  const codex = join(dir, "codex-home");
  const guide = join(dir, "guide.md");
  writeFileSync(guide, "use `srv`\n");
  const code = await seed({ CLAUDE_CONFIG_DIR: dir, CODEX_HOME: codex, DEVBOX_GUIDE: guide, HOME: dir });
  expect(code).toBe(0);
  const agents = readFileSync(join(codex, "AGENTS.md"), "utf8");
  expect(agents).toBe(readFileSync(join(dir, "CLAUDE.md"), "utf8"));
  expect(agents).toContain("use `srv`");
  expect(count(agents, /BEGIN devbox-guide/g)).toBe(1);
  rmSync(dir, { recursive: true, force: true });
});

test("AGENTS.md: re-run does not duplicate, an update propagates, user content stays", async () => {
  const dir = tmp();
  const codex = join(dir, "codex-home");
  const guide = join(dir, "guide.md");
  writeFileSync(guide, "GUIDE-V1\n");
  mkdirSync(codex, { recursive: true });
  writeFileSync(join(codex, "AGENTS.md"), "MY CODEX NOTES\n");
  await seed({ CLAUDE_CONFIG_DIR: dir, CODEX_HOME: codex, DEVBOX_GUIDE: guide, HOME: dir });
  writeFileSync(guide, "GUIDE-V2\n");
  await seed({ CLAUDE_CONFIG_DIR: dir, CODEX_HOME: codex, DEVBOX_GUIDE: guide, HOME: dir });
  const agents = readFileSync(join(codex, "AGENTS.md"), "utf8");
  expect(agents).toContain("GUIDE-V2");
  expect(agents).not.toContain("GUIDE-V1");
  expect(agents).toContain("MY CODEX NOTES");
  expect(count(agents, /BEGIN devbox-guide/g)).toBe(1);
  rmSync(dir, { recursive: true, force: true });
});

// --- Grok target (AGENTS.md) -------------------------------------------------
// Grok also reads AGENTS.md (verified in Task 7 via `grok inspect --json`, same as
// Codex), in its own GROK_HOME — it shares the contract with the Codex target above (the seed_into
// function is the same for both, just a different path).

test("also seeds Grok AGENTS.md, with the same block as CLAUDE.md and Codex", async () => {
  const dir = tmp();
  const grok = join(dir, "grok-home");
  const guide = join(dir, "guide.md");
  writeFileSync(guide, "use `srv`\n");
  const code = await seed({ CLAUDE_CONFIG_DIR: dir, GROK_HOME: grok, DEVBOX_GUIDE: guide, HOME: dir });
  expect(code).toBe(0);
  const agents = readFileSync(join(grok, "AGENTS.md"), "utf8");
  expect(agents).toBe(readFileSync(join(dir, "CLAUDE.md"), "utf8"));
  expect(agents).toContain("use `srv`");
  expect(count(agents, /BEGIN devbox-guide/g)).toBe(1);
  rmSync(dir, { recursive: true, force: true });
});

test("an unwritable first target does not prevent seeding the second", async () => {
  const dir = tmp();
  const guide = join(dir, "guide.md");
  writeFileSync(guide, "GUIDE\n");
  const codex = join(dir, "codex-home");
  // The Claude target is first in order; a file instead of a directory → mkdir -p under it fails.
  // seed_into must return (not exit) so the Codex target still gets its block.
  const blocked = join(dir, "blocked");
  writeFileSync(blocked, "");
  const code = await seed({ CLAUDE_CONFIG_DIR: blocked, CODEX_HOME: codex, DEVBOX_GUIDE: guide, HOME: dir });
  expect(code).toBe(0);
  expect(readFileSync(join(codex, "AGENTS.md"), "utf8")).toContain("GUIDE");
  rmSync(dir, { recursive: true, force: true });
});

// --- Antigravity target (AGENTS.md) ---------------------------------------------
// Antigravity (agy) reads AGENTS.md in the global customization root ~/.gemini/config/,
// same as Codex and Grok.

test("also seeds Antigravity AGENTS.md in agy's global customizations", async () => {
  const dir = tmp();
  const agy = join(dir, "agy-config");
  const guide = join(dir, "guide.md");
  writeFileSync(guide, "use `srv`\n");
  const code = await seed({ CLAUDE_CONFIG_DIR: dir, AGY_CONFIG: agy, DEVBOX_GUIDE: guide, HOME: dir });
  expect(code).toBe(0);
  const agents = readFileSync(join(agy, "AGENTS.md"), "utf8");
  expect(agents).toBe(readFileSync(join(dir, "CLAUDE.md"), "utf8"));
  expect(count(agents, /BEGIN devbox-guide/g)).toBe(1);
  rmSync(dir, { recursive: true, force: true });
});
