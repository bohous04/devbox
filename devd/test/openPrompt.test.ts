// The optional first prompt of POST /api/sessions: a chat session gets it as its first turn through the bridge link's
// stored-turn path, a tmux session through the prompt file agent-launch reads once. No new delivery mechanism.
import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, reportFirstPromptFailed, reportPrunedFirstPrompts } from "../src/api";
import { USER_FIRST_PROMPT_TAG } from "../src/bridgeLink";
import { DEFAULT_CONFIG } from "../src/config";
import { insertSession, openDb, prunePendingFirstTurns, savePendingFirstTurn, setRepoAgent } from "../src/db";
import { MAX_FIRST_PROMPT_BYTES, SessionManager } from "../src/sessions";

const IMAGE = join(import.meta.dir, "..", "..", "image");

type Opened = { created: boolean; session: { id: string; status: string; runtime: string; project?: string; repo?: string }; claudePrompt?: string };
interface Harness {
  addr?: string;
  /** A first turn already waiting on the link (a scheduled run's, or devd's own). */
  queued?: boolean;
  /** Runs in the joined session's thread. */
  runs?: { status: string }[];
  /** No bridge links (a devd without chat support wired). */
  noLinks?: boolean;
  /** startTurnWhenConnected throws (the pending-turn DB write fails). */
  queueFails?: boolean;
}
function appWith(open: (t: Record<string, unknown>) => Promise<Opened>, h: Harness = {}) {
  const turns: { id: string; text: string; onDone?: (err: Error | null) => void; tag: string | null }[] = [];
  const notices: string[] = [];
  const notified: string[] = [];
  const db = openDb(":memory:");
  const ensured: string[] = [];
  const links = h.noLinks ? undefined : {
    ensure: (id: string) => { ensured.push(id); }, send: async () => {}, hasFirstTurn: () => h.queued ?? false,
    startTurnWhenConnected: (id: string, text: string, onDone?: (err: Error | null) => void, tag: string | null = null) => {
      if (h.queueFails) throw new Error("disk full");
      turns.push({ id, text, onDone, tag });
    },
  };
  const threads = () => ({ snapshot: () => ({ runs: h.runs ?? [] }), addNotice: (text: string) => { notices.push(text); } });
  const app = createApp({
    mgr: { open, openSolo: async () => { throw new Error("openSolo must not be called"); } } as never,
    db, cfg: DEFAULT_CONFIG, root: "/tmp", tree: async () => [],
    listener: {} as never, notify: (_t: string, body: string) => { notified.push(body); }, stats: () => ({}),
    cloneQueue: {} as never, configRepo: { read: () => DEFAULT_CONFIG } as never, dashboardDir: "/tmp",
    backup: { build: async () => "/tmp/x", restore: async () => {} }, links, threads,
    remoteAddr: () => ("addr" in h ? h.addr : "127.0.0.1"),
  } as never);
  return { app, turns, notices, notified, db, ensured };
}
const post = (a: { app: ReturnType<typeof createApp> }, body: unknown) =>
  a.app.request("/api/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const BASE = { folder: "f", project: "p", repo: "r" };
const chatOpened = (claudePrompt?: string): Opened => ({ created: true, session: { id: "dev-p-r", status: "running", runtime: "chat" }, ...(claudePrompt ? { claudePrompt } : {}) });
const tmuxOpened: Opened = { created: true, session: { id: "dev-p-r", status: "running", runtime: "tmux" } };

test("chat: the prompt becomes the first turn through the bridge link, never the prompt file", async () => {
  const seen: Record<string, unknown>[] = [];
  const a = appWith(async (t) => { seen.push(t); return chatOpened(); });
  const r = await post(a, { ...BASE, runtime: "chat", prompt: "  Fix the flaky test  " });
  expect(r.status).toBe(201);
  expect(seen[0]!.firstPrompt).toBeUndefined();
  expect(seen[0]!.prompt).toBeUndefined();
  expect(a.turns.map(({ id, text }) => ({ id, text }))).toEqual([{ id: "dev-p-r", text: "Fix the flaky test" }]);
});

test("chat: devd's pull-conflict message goes first, the prompt follows in the same turn (one first message)", async () => {
  const a = appWith(async () => chatOpened("Resolve the conflict"));
  expect((await post(a, { ...BASE, runtime: "chat", prompt: "Then fix the test" })).status).toBe(201);
  expect(a.turns.map(({ id, text }) => ({ id, text }))).toEqual([{ id: "dev-p-r", text: "Resolve the conflict\n\nThen fix the test" }]);
});

test("chat: a session that is not running yet still gets the prompt once its bridge connects, never dropped", async () => {
  const a = appWith(async () => ({ created: false, session: { id: "dev-p-r", status: "stopped", runtime: "chat" } }));
  expect((await post(a, { ...BASE, runtime: "chat", prompt: "fix the login bug" })).status).toBe(200);
  expect(a.turns.map((t) => t.text)).toEqual(["fix the login bug"]);
  // Tagged, so a devd restart before delivery still reports its outcome (index.ts onRestoredTurnDone).
  expect(a.turns[0]!.tag).toBe(USER_FIRST_PROMPT_TAG);
  expect(a.ensured).toEqual([]); // the link sync connects it when the session runs
});

test("chat: without bridge links the prompt is refused before anything opens; a failed queue is reported", async () => {
  let calls = 0;
  const none = appWith(async () => { calls++; return chatOpened(); }, { noLinks: true });
  const r = await post(none, { ...BASE, runtime: "chat", prompt: "fix the login bug" });
  expect(r.status).toBe(503);
  expect(calls).toBe(0);
  const failing = appWith(async () => chatOpened(), { queueFails: true });
  expect((await post(failing, { ...BASE, runtime: "chat", prompt: "fix the login bug" })).status).toBe(201);
  expect(failing.notices.join()).toContain("Your first message was not delivered (disk full)");
  expect(failing.notified.join()).toContain("disk full");
});

test("tmux: a leading '-' is refused for Antigravity only (agy reads the -i value as flags), before anything opens", async () => {
  let calls = 0;
  const a = appWith(async () => { calls++; return tmuxOpened; });
  const r = await post(a, { ...BASE, runtime: "tmux", agent: "antigravity", prompt: "-v fix it" });
  expect(r.status).toBe(400);
  expect((await r.json() as { error: string }).error).toContain("Antigravity");
  expect(calls).toBe(0);
  // The repo's remembered agent counts too.
  setRepoAgent(a.db, "f", "p", "r", "antigravity", 0);
  expect((await post(a, { ...BASE, runtime: "tmux", prompt: "-v fix it" })).status).toBe(400);
  expect((await post(a, { ...BASE, runtime: "tmux", prompt: "fix it -v" })).status).toBe(201);
  expect((await post(a, { ...BASE, runtime: "tmux", agent: "codex", prompt: "-v fix it" })).status).toBe(201);
});

test("chat: a prompt starting with '-' is plain text there", async () => {
  const a = appWith(async () => chatOpened());
  expect((await post(a, { ...BASE, runtime: "chat", prompt: "-v flag is broken" })).status).toBe(201);
  expect(a.turns[0]!.text).toBe("-v flag is broken");
});

test("tmux: the prompt goes to open() as firstPrompt (the prompt file), trimmed", async () => {
  const seen: Record<string, unknown>[] = [];
  const a = appWith(async (t) => { seen.push(t); return tmuxOpened; });
  expect((await post(a, { ...BASE, runtime: "tmux", prompt: "\nFix it\n" })).status).toBe(201);
  expect(seen[0]!.firstPrompt).toBe("Fix it");
  expect(seen[0]!.prompt).toBeUndefined();
  expect(a.turns).toEqual([]);
});

test("an empty or whitespace prompt is the same as none", async () => {
  const seen: Record<string, unknown>[] = [];
  const a = appWith(async (t) => { seen.push(t); return chatOpened(); });
  expect((await post(a, { ...BASE, runtime: "chat", prompt: "  \n " })).status).toBe(201);
  expect((await post(a, { ...BASE, runtime: "tmux", prompt: "" })).status).toBe(201);
  expect(seen.every((t) => t.firstPrompt === undefined)).toBe(true);
  expect(a.turns).toEqual([]);
});

test("refused explicitly, before anything opens: type, controls, size, runtime, InstaBox, solo, tmux one word", async () => {
  let calls = 0;
  const a = appWith(async () => { calls++; return tmuxOpened; });
  const cases: [unknown, number, string][] = [
    [{ ...BASE, runtime: "chat", prompt: 42 }, 400, "prompt must be a string"],
    [{ ...BASE, runtime: "chat", prompt: "a\u0000b" }, 400, "prompt must not contain control characters (other than tab and newlines)"],
    [{ ...BASE, runtime: "chat", prompt: "clear \u001b[2J screen" }, 400, "prompt must not contain control characters (other than tab and newlines)"],
    [{ ...BASE, runtime: "chat", prompt: "a\u007fb" }, 400, "prompt must not contain control characters (other than tab and newlines)"],
    [{ ...BASE, runtime: "chat", prompt: "a\u009bb" }, 400, "prompt must not contain control characters (other than tab and newlines)"],
    [{ ...BASE, runtime: "chat", prompt: "a\u0085b" }, 400, "prompt must not contain control characters (other than tab and newlines)"],
    // Bytes, not characters: 4-byte emoji cross the cap at a quarter of the length.
    [{ ...BASE, runtime: "chat", prompt: "😀".repeat(MAX_FIRST_PROMPT_BYTES / 4 + 1) }, 413, `prompt is larger than ${MAX_FIRST_PROMPT_BYTES} bytes`],
    [{ ...BASE, prompt: "hi there" }, 400, "a prompt needs an explicit runtime (tmux|chat)"],
    [{ ...BASE, runtime: "tmux", host: "instabox", cloneUrl: "https://git.example/x.git", prompt: "hi there" }, 400, "InstaBox sessions do not take a first prompt"],
    [{ folder: "f", project: "p", solo: true, runtime: "tmux", prompt: "hi there" }, 400, "claudeSolo sessions do not take a first prompt"],
    // A single word is the CLI's subcommand (`logout`, `update`, `mcp`, …), not a prompt.
    [{ ...BASE, runtime: "tmux", prompt: "logout" }, 400, "a terminal session's first prompt must be more than one word (the agent CLI would run a single word as its subcommand)"],
  ];
  for (const [body, status, error] of cases) {
    const r = await post(a, body);
    expect(r.status).toBe(status);
    expect((await r.json() as { error: string }).error).toBe(error);
  }
  expect(calls).toBe(0);
  // Tabs and newlines are text; exactly at the cap is fine; one word is fine in chat (plain text there).
  expect((await post(a, { ...BASE, runtime: "tmux", prompt: "fix\tit\r\nnow" })).status).toBe(201);
  // agent-launch passes the prompt after `--`, so a leading '-' is text; U+00A0 is just past the C1 block.
  expect((await post(a, { ...BASE, runtime: "tmux", prompt: "--dangerous flag" })).status).toBe(201);
  expect((await post(a, { ...BASE, runtime: "tmux", prompt: "café\u00a0now" })).status).toBe(201);
  expect((await post(a, { ...BASE, runtime: "tmux", prompt: `a ${"x".repeat(MAX_FIRST_PROMPT_BYTES - 2)}` })).status).toBe(201);
  const chat = appWith(async () => chatOpened());
  expect((await post(chat, { ...BASE, runtime: "chat", prompt: "continue" })).status).toBe(201);
});

test("\"prompt\": null is the same as no prompt (the old behaviour)", async () => {
  const seen: Record<string, unknown>[] = [];
  const a = appWith(async (t) => { seen.push(t); return tmuxOpened; });
  expect((await post(a, { ...BASE, prompt: null })).status).toBe(201);
  expect(seen[0]!.firstPrompt).toBeUndefined();
});

test("a prompt from a container address (an agent opening a session) is refused with 403, nothing opens", async () => {
  for (const addr of ["172.17.0.5", undefined]) {
    let calls = 0;
    const a = appWith(async () => { calls++; return chatOpened(); }, { addr });
    const r = await post(a, { ...BASE, runtime: "chat", prompt: "hi there" });
    expect(r.status).toBe(403);
    expect((await r.json() as { error: string }).error).toBe("a first prompt can only come from the dashboard or a trusted device, not from a container");
    expect(calls).toBe(0);
    // Without a prompt the request is what it always was.
    expect((await post(a, { ...BASE, runtime: "chat" })).status).toBe(201);
  }
});

test("chat: a joined session with a run going or a first turn already queued → 409, nothing overwritten", async () => {
  const joined: Opened = { created: false, session: { id: "dev-p-r", status: "running", runtime: "chat" } };
  for (const h of [{ runs: [{ status: "running" }] }, { runs: [{ status: "queued" }] }, { queued: true }]) {
    const a = appWith(async () => joined, h);
    const r = await post(a, { ...BASE, runtime: "chat", prompt: "hi there" });
    expect(r.status).toBe(409);
    expect((await r.json() as { error: string }).error).toContain("dev-p-r");
    expect(a.turns).toEqual([]);
  }
  // A finished run is no obstacle.
  const idle = appWith(async () => joined, { runs: [{ status: "completed" }] });
  expect((await post(idle, { ...BASE, runtime: "chat", prompt: "hi there" })).status).toBe(200);
  expect(idle.turns.length).toBe(1);
});

test("chat: a first turn the bridge refuses or never takes is said in the thread, the event log and a notification", async () => {
  const a = appWith(async () => ({ ...chatOpened(), session: { id: "dev-p-r", status: "running", runtime: "chat", project: "p", repo: "r" } }));
  expect((await post(a, { ...BASE, runtime: "chat", prompt: "hi there" })).status).toBe(201);
  a.turns[0]!.onDone!(new Error("bridge refused"));
  expect(a.notices).toEqual(["Your first message was not delivered (bridge refused). Send it again."]);
  expect(a.notified).toEqual(["First message to dev-p-r was not delivered: bridge refused"]);
  const ev = a.db.query("SELECT type, data FROM events WHERE session_id='dev-p-r'").all() as { type: string; data: string }[];
  expect(ev).toEqual([{ type: "first_prompt_failed", data: JSON.stringify({ error: "bridge refused" }) }]);
  // Delivered: nothing to say.
  const ok = appWith(async () => chatOpened());
  await post(ok, { ...BASE, runtime: "chat", prompt: "hi there" });
  ok.turns[0]!.onDone!(null);
  expect(ok.notices).toEqual([]);
});

function manager() {
  const db = openDb(":memory:");
  const root = mkdtempSync(join(tmpdir(), "first-prompt-"));
  const mgr = new SessionManager({ db, cfg: DEFAULT_CONFIG, root, image: "alpine:3", controlRoot: join(root, "ctl") });
  const sync = (mgr as unknown as { syncPromptFile: (id: string, runtime: string, pull: unknown, override?: string, first?: string) => string | undefined }).syncPromptFile.bind(mgr);
  return { sync, file: (id: string) => join(root, "ctl", id, "prompt") };
}

test("prompt file: the first prompt is written as is; after a pull conflict it follows the conflict task", () => {
  const { sync, file } = manager();
  expect(sync("dev-a", "tmux", { status: "clean" }, undefined, "Fix it")).toBe("Fix it");
  expect(readFileSync(file("dev-a"), "utf8")).toBe("Fix it");
  const both = sync("dev-b", "tmux", { status: "conflict", files: ["a.ts"] }, undefined, "Fix it")!;
  expect(both).toContain("a.ts");
  expect(both.endsWith("\n\nFix it")).toBe(true);
  expect(readFileSync(file("dev-b"), "utf8")).toBe(both);
  // A scheduled override keeps yielding to the conflict, as before.
  expect(sync("dev-c", "tmux", { status: "conflict", files: ["a.ts"] }, "scheduled task")).not.toContain("scheduled task");
});

// The prompt file is data: agent-launch reads it with $(cat) and passes it as one quoted argv word. Nothing in it is
// expanded by a shell — quotes, $(…), backticks and newlines reach the agent CLI byte for byte.
test("agent-launch passes a hostile prompt file as one argv word, never interpreting it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "first-prompt-launch-"));
  const argvOut = join(dir, "argv");
  writeFileSync(join(dir, "cc"), `#!/bin/sh\nfor a in "$@"; do printf '%s\\0' "$a"; done > '${argvOut}'\n`);
  writeFileSync(join(dir, "zsh"), "#!/bin/sh\nexit 0\n");
  for (const f of ["cc", "zsh"]) chmodSync(join(dir, f), 0o755);
  const pwned = join(dir, "pwned");
  const prompt = `it's "quoted" $(touch ${pwned}) \`touch ${pwned}2\` $HOME\nsecond line; rm -rf / #\n-leading dash on a later line`;
  const promptFile = join(dir, "prompt");
  writeFileSync(promptFile, prompt);
  const p = Bun.spawn(["bash", join(IMAGE, "agent-launch.sh"), "claude"], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, DEVD_AGENT: "", DEVD_PROMPT_FILE: promptFile },
    stdin: "ignore", stdout: "ignore", stderr: "ignore",
  });
  await p.exited;
  const argv = readFileSync(argvOut, "utf8").split("\0").slice(0, -1);
  expect(argv.at(-1)).toBe(prompt);
  expect(existsSync(pwned)).toBe(false);
  expect(existsSync(`${pwned}2`)).toBe(false);
  expect(existsSync(promptFile)).toBe(false); // consumed once
});

test("firstPromptRefusal: only a tmux session whose agent launches now (new, or a stopped container) takes the file", async () => {
  const { firstPromptRefusal } = await import("../src/sessions");
  const row = (over: Record<string, unknown>) => ({ id: "dev-p-r", folder: "f", project: "p", repo: "r", container: "dev-p-r", port_base: 40100,
    status: "running", solo: 0, created_at: 0, last_active_at: 0, important: 0, runtime: "tmux", ...over }) as never;
  expect(firstPromptRefusal(null, "tmux", "missing", false)).toBeNull();
  expect(firstPromptRefusal(row({}), "tmux", "stopped", false)).toBeNull();
  expect(firstPromptRefusal(row({}), "tmux", "missing", false)).toBeNull();
  expect(firstPromptRefusal(row({}), "tmux", "running", false)).toContain("already running");
  expect(firstPromptRefusal(row({ host: "instabox" }), "tmux", "missing", false)).toBe("InstaBox sessions do not take a first prompt");
  expect(firstPromptRefusal(row({ runtime: "chat" }), "tmux", "stopped", false)).toContain("bridge");
  expect(firstPromptRefusal(null, "chat", "missing", false)).toContain("bridge");
  // A recovery journal makes agent-launch skip the prompt file; it would fire later in another agent window.
  expect(firstPromptRefusal(row({}), "tmux", "stopped", true)).toContain("recovery");
});

test("a FirstPromptRefused from open() is a 409 with its reason", async () => {
  const { FirstPromptRefused } = await import("../src/sessions");
  const a = appWith(async () => { throw new FirstPromptRefused("dev-p-r is already running"); });
  const r = await post(a, { ...BASE, runtime: "tmux", prompt: "hi there" });
  expect(r.status).toBe(409);
  expect((await r.json() as { error: string }).error).toBe("dev-p-r is already running");
});

test("a prompt for a named session of the other runtime is refused, not lost", async () => {
  const { insertSession } = await import("../src/db");
  let calls = 0;
  const own = openDb(":memory:");
  insertSession(own, { id: "dev-p-r", folder: "f", project: "p", repo: "r", container: "dev-p-r", port_base: 40100,
    status: "running", solo: 0, created_at: 0, last_active_at: 0, important: 0, runtime: "tmux" });
  const app = createApp({
    mgr: { open: async () => { calls++; return chatOpened(); } } as never, db: own, cfg: DEFAULT_CONFIG, root: "/tmp", tree: async () => [],
    listener: {} as never, notify: () => {}, stats: () => ({}), cloneQueue: {} as never,
    configRepo: { read: () => DEFAULT_CONFIG } as never, dashboardDir: "/tmp",
    backup: { build: async () => "/tmp/x", restore: async () => {} }, links: { ensure: () => {}, hasFirstTurn: () => false, startTurnWhenConnected: () => {} },
    remoteAddr: () => "127.0.0.1",
  } as never);
  const r = await post({ app }, { ...BASE, runtime: "chat", sessionId: "dev-p-r", prompt: "hi" });
  expect(r.status).toBe(400);
  expect((await r.json() as { error: string }).error).toBe("dev-p-r is a tmux session; the prompt was sent for chat");
  expect(calls).toBe(0);
});

test("reportFirstPromptFailed (also used after a devd restart) says it in the thread, the event log and a notification", () => {
  const db = openDb(":memory:");
  const notices: string[] = []; const notified: string[] = [];
  reportFirstPromptFailed({ db, threads: () => ({ addNotice: (t: string) => { notices.push(t); } }), notify: (_t: string, b: string) => { notified.push(b); } },
    { id: "dev-p-r", project: "p", repo: "r" }, new Error("first message discarded before it was sent"));
  expect(notices[0]).toContain("Your first message was not delivered (first message discarded before it was sent)");
  expect(notified[0]).toContain("dev-p-r");
  expect((db.query("SELECT type FROM events").all() as { type: string }[]).map((e) => e.type)).toEqual(["first_prompt_failed"]);
});

test("boot: a user's first prompt pruned with its not-running session is reported; a scheduled run's stays silent", () => {
  const db = openDb(":memory:");
  const mk = (id: string, port: number) => insertSession(db, { id, folder: "f", project: "p", repo: id, container: id, port_base: port, status: "stopped", solo: 0, created_at: 0, last_active_at: 0, important: 0, runtime: "chat" } as never);
  mk("dev-p-user", 1); mk("dev-p-sched", 2);
  savePendingFirstTurn(db, "dev-p-user", "fix the login bug", 0, USER_FIRST_PROMPT_TAG);
  savePendingFirstTurn(db, "dev-p-sched", "scheduled prompt", 0, "Nightly bump");
  savePendingFirstTurn(db, "dev-p-gone", "fix it", 0, USER_FIRST_PROMPT_TAG);
  const notices: [string, string][] = []; const notified: string[] = [];
  reportPrunedFirstPrompts({ db, threads: (id: string) => ({ addNotice: (t: string) => { notices.push([id, t]); } }), notify: (_t: string, b: string) => { notified.push(b); } },
    prunePendingFirstTurns(db));
  expect(notices).toEqual([["dev-p-user", "Your first message was not delivered (devd restarted while the session was not running). Send it again."]]);
  expect(notified).toHaveLength(1);
  expect(notified[0]).toContain("dev-p-user");
  expect((db.query("SELECT session_id, type FROM events").all() as { session_id: string; type: string }[])).toEqual([{ session_id: "dev-p-user", type: "first_prompt_failed" }]);
});

test("continue: a named chat session with a prompt gets it as an ordinary turn (startTurn), the 409 rules unchanged", async () => {
  const seen: Record<string, unknown>[] = [];
  const joined: Opened = { created: false, session: { id: "dev-p-r", status: "running", runtime: "chat" } };
  const a = appWith(async (t) => { seen.push(t); return joined; });
  insertSession(a.db, { id: "dev-p-r", folder: "f", project: "p", repo: "r", container: "dev-p-r", port_base: 40100,
    status: "running", solo: 0, created_at: 0, last_active_at: 0, important: 0, runtime: "chat" } as never);
  const r = await post(a, { ...BASE, runtime: "chat", sessionId: "dev-p-r", prompt: "also cover the empty case" });
  expect(r.status).toBe(200);
  expect(seen[0]).toMatchObject({ sessionId: "dev-p-r", runtime: "chat" });
  expect(a.turns.map((t) => [t.id, t.text])).toEqual([["dev-p-r", "also cover the empty case"]]);
  // Busy: refused with 409 as before, nothing queued.
  const busy = appWith(async () => joined, { runs: [{ status: "running" }] });
  insertSession(busy.db, { id: "dev-p-r", folder: "f", project: "p", repo: "r", container: "dev-p-r", port_base: 40100,
    status: "running", solo: 0, created_at: 0, last_active_at: 0, important: 0, runtime: "chat" } as never);
  expect((await post(busy, { ...BASE, runtime: "chat", sessionId: "dev-p-r", prompt: "also cover the empty case" })).status).toBe(409);
  expect(busy.turns).toEqual([]);
});
