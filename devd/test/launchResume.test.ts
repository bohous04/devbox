import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config";
import { openDb } from "../src/db";
import type { ResumeSeed } from "../src/endedSessions";
import { SessionManager } from "../src/sessions";

// A tmux session that continues an ended one: agent-launch reads devd's one-time resume file
// (`/run/devd/resume`, `<harness> <thread id>`) and starts Claude Code on that conversation.
const IMAGE = join(import.meta.dir, "..", "..", "image");
const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

async function launch(resume: string | null, profile = "claude") {
  const dir = mkdtempSync(join(tmpdir(), "launch-resume-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const argvOut = join(dir, "argv");
  for (const bin of ["cc", "co"]) writeFileSync(join(dir, bin), `#!/bin/sh\nfor a in "$@"; do printf '%s\\0' "$a"; done > '${argvOut}'\n`);
  writeFileSync(join(dir, "zsh"), "#!/bin/sh\nexit 0\n");
  for (const f of ["cc", "co", "zsh"]) chmodSync(join(dir, f), 0o755);
  const resumeFile = join(dir, "resume");
  if (resume !== null) writeFileSync(resumeFile, resume);
  const p = Bun.spawn(["bash", join(IMAGE, "agent-launch.sh"), profile], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, DEVD_AGENT: "", DEVD_PROMPT_FILE: join(dir, "prompt"), DEVD_RESUME_FILE: resumeFile },
    stdin: "ignore", stdout: "ignore", stderr: "pipe",
  });
  const stderr = await new Response(p.stderr).text();
  await p.exited;
  return { argv: readFileSync(argvOut, "utf8").split("\0").slice(0, -1), stderr, consumed: !existsSync(resumeFile) };
}

test("a Claude launch with a resume file resumes that conversation, once", async () => {
  const r = await launch("claude 0b1c2d3e-0000-4000-8000-000000000001\n");
  expect(r.argv).toEqual(["--resume", "0b1c2d3e-0000-4000-8000-000000000001"]);
  expect(r.consumed).toBe(true);
});

test("a resume file it cannot use is said on stderr and consumed; the agent starts new", async () => {
  for (const [text, profile] of [["claude $(touch /tmp/x) ; rm", "claude"], ["claude 0b1c2d3e-0000-4000-8000-000000000001", "codex"]] as const) {
    const r = await launch(text, profile);
    expect(r.argv).toEqual([]);
    expect(r.stderr).toContain("not resumed");
    expect(r.consumed).toBe(true);
  }
});

test("without a resume file nothing changes", async () => {
  expect((await launch(null)).argv).toEqual([]);
});

// devd's half: the conversation goes into the new session's Claude projects dir, the resume file into its control dir.
function manager() {
  const db = openDb(":memory:");
  const root = mkdtempSync(join(tmpdir(), "continue-resume-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const mgr = new SessionManager({ db, cfg: DEFAULT_CONFIG, root, image: "devbox:test", controlRoot: join(root, "ctl") });
  const priv = mgr as unknown as {
    syncContinueFiles: (id: string, t: { resume?: ResumeSeed; handoff?: string }) => Promise<void>;
    runOpts: (id: string, ws: string, portBase: number, project: string, repo: string, agent: string, runtime: string) => Promise<{ extraMounts: string[] }>;
  };
  const seed = (id: string, resume?: ResumeSeed) => priv.syncContinueFiles.call(mgr, id, resume ? { resume } : {});
  const handoff = (id: string, text: string) => priv.syncContinueFiles.call(mgr, id, { handoff: text });
  const mounts = async (id: string) => (await priv.runOpts.call(mgr, id, join(root, "ws"), 41500, "a", "b", "claude", "chat")).extraMounts;
  return { mgr, root, seed, handoff, mounts };
}

const THREAD = "0b1c2d3e-0000-4000-8000-000000000001";

test("a session that continues a conversation gets its jsonl and the resume file; any other new session none", async () => {
  const { root, seed } = manager();
  await seed("dev-a-b", { harness: "claude", thread: THREAD, jsonl: Buffer.from('{"type":"user"}\n') });
  expect(readFileSync(join(root, "_claude-projects", "dev-a-b", `${THREAD}.jsonl`), "utf8")).toBe('{"type":"user"}\n');
  expect(readFileSync(join(root, "ctl", "dev-a-b", "resume"), "utf8")).toBe(`claude ${THREAD}\n`);
  // The id comes back for a later session, which must not resume what the old image left unread.
  await seed("dev-a-b");
  expect(existsSync(join(root, "ctl", "dev-a-b", "resume"))).toBe(false);
});

test("a session that continues a Codex chat thread gets only the resume file: the rollout stays in the shared Codex home", async () => {
  const { root, seed } = manager();
  await seed("dev-a-b", { harness: "codex", thread: THREAD });
  expect(readFileSync(join(root, "ctl", "dev-a-b", "resume"), "utf8")).toBe(`codex ${THREAD}\n`);
  expect(existsSync(join(root, "_claude-projects", "dev-a-b", `${THREAD}.jsonl`))).toBe(false);
});

test("resumeImageBlock asks the image for its resume label and says why it cannot", async () => {
  const bin = mkdtempSync(join(tmpdir(), "fake-docker-"));
  cleanups.push(() => rmSync(bin, { recursive: true, force: true }));
  const label = join(bin, "label");
  writeFileSync(join(bin, "docker"), `#!/usr/bin/env bash\ncat '${label}'\n`);
  chmodSync(join(bin, "docker"), 0o755);
  const orig = process.env.PATH;
  process.env.PATH = `${bin}:${orig}`;
  try {
    const { mgr } = manager();
    writeFileSync(label, "1\n");
    expect(await mgr.resumeImageBlock()).toBeNull();
    writeFileSync(label, "<no value>\n");
    expect(await mgr.resumeImageBlock()).toContain("devbox:test predates");
  } finally {
    process.env.PATH = orig;
  }
});

test("a handoff transcript goes to the new session alone: its control dir, never the /inbox every container mounts", async () => {
  const { root, handoff, mounts } = manager();
  await handoff("dev-a-b", "# Secret plan\n");
  expect(readFileSync(join(root, "ctl", "dev-a-b", "ended-transcript.md"), "utf8")).toBe("# Secret plan\n");
  expect(existsSync(join(root, "_inbox"))).toBe(false);
  // Another session mounts its own control dir and the shared /inbox: neither holds the file.
  const other = await mounts("dev-c-d");
  expect(other).toContain(`${join(root, "ctl", "dev-c-d")}:/run/devd`);
  expect(other.some((m) => m.startsWith(join(root, "ctl", "dev-a-b")))).toBe(false);
  const inbox = other.find((m) => m.endsWith(":/inbox:ro"))!;
  expect(existsSync(join(inbox.split(":")[0]!, "_ended"))).toBe(false);
  expect((await mounts("dev-a-b"))).toContain(`${join(root, "ctl", "dev-a-b")}:/run/devd`);
});
