// The Codex adapter against the real `codex app-server` binary, with every model request going to a loopback
// Responses fixture: no account, no network, a fresh CODEX_HOME. Skipped where codex is not installed (CI).
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareShadowHome } from "../src/codexHomes.ts";
import { openCodexSession } from "../src/codexSession.ts";
import type { BridgeEvent } from "../src/events.ts";

const codex = Bun.which("codex");
const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

type Item = Record<string, unknown>;

/** A Responses endpoint that answers the n-th request with `script[n]` (one output item) and records every request. */
function responsesFixture(script: Item[]) {
  const requests: any[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      if (new URL(req.url).pathname !== "/v1/responses") return new Response("not found", { status: 404 });
      requests.push(await req.json());
      const item = script[Math.min(requests.length, script.length) - 1]!;
      const id = `resp_${requests.length}`;
      const events = [
        { type: "response.created", response: { id } },
        { type: "response.output_item.done", output_index: 0, item },
        { type: "response.completed", response: { id, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
      ];
      return new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    },
  });
  cleanups.push(() => server.stop(true));
  return { url: `http://127.0.0.1:${server.port}/v1`, requests };
}

const fixtureConfig = (url: string) => [
  'model = "gpt-5.4"', 'model_provider = "fixture"',
  "[model_providers.fixture]", 'name = "Loopback fixture"', `base_url = ${JSON.stringify(url)}`,
  'wire_api = "responses"', "requires_openai_auth = false", "supports_websockets = false", "",
].join("\n");

const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-live-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

function codexHome(url: string): string {
  const home = tmp();
  writeFileSync(join(home, "config.toml"), fixtureConfig(url));
  return home;
}

const say = (text: string, id: string) => ({ type: "message", id, role: "assistant", content: [{ type: "output_text", text }] });

async function until(cond: () => boolean, ms = 30_000) {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await Bun.sleep(20);
  expect(cond()).toBe(true);
}

describe.skipIf(codex === null)("codex app-server (real binary, loopback model)", () => {
  // DEVBOX-34: in the default collaboration mode Codex refuses request_user_input unless the feature is on; the
  // model then gets an error instead of the user's answer and asks in plain text.
  test("request_user_input in the default mode reaches the user and the answer goes back to the model", async () => {
    const question = {
      questions: [{ id: "db", header: "Database", question: "Which database?", options: [
        { label: "Postgres", description: "server" }, { label: "SQLite", description: "file" },
      ] }],
    };
    const fx = responsesFixture([
      { type: "function_call", id: "fc_1", call_id: "call_ask", name: "request_user_input", arguments: JSON.stringify(question) },
      say("Using SQLite.", "msg_1"),
    ]);
    const home = codexHome(fx.url);
    const events: BridgeEvent[] = [];
    const session = openCodexSession({
      cwd: home, model: null, codexHome: home, baseEnv: { PATH: process.env.PATH, HOME: home }, resume: null,
      mcpConfigArgs: [], developerInstructions: "", emit: (e) => events.push(e), logError: () => {},
    });
    cleanups.push(() => void session.close());
    await session.ready;
    await session.startTurn("run-1", "set up a db", "user");

    await until(() => events.some((e) => e.type === "request.opened" || e.type === "run.completed" || e.type === "run.failed"));
    const opened = events.find((e) => e.type === "request.opened") as Extract<BridgeEvent, { type: "request.opened" }> | undefined;
    expect(opened).toMatchObject({ kind: "question", prompt: "Which database?", options: [{ label: "Postgres" }, { label: "SQLite" }] });
    await session.answer(opened!.requestId, "SQLite");

    await until(() => events.some((e) => e.type === "run.completed"));
    const output = fx.requests[1].input.find((i: Item) => i.type === "function_call_output" && i.call_id === "call_ask");
    expect(JSON.stringify(output.output)).toContain("SQLite");
  }, 60_000);

  // Continuing an ended chat session (devd endedSessions.ts): the new session's bridge forks the thread on another
  // account's shadow home, which shares sessions/ and sqlite/ with every other account in the codex-v2-shared volume.
  // A fork has its own id, so a second continue of the same ended session works while the first is live (review M1:
  // resuming it twice failed with "thread-store conflict: active writer").
  test("a new app-server on another account's shadow home forks a thread an ended one wrote, twice at once", async () => {
    const fx = responsesFixture([say("Noted: blue.", "msg_1"), say("It was blue.", "msg_2"), say("Still blue.", "msg_3")]);
    const root = tmp();
    const paths = { sharedHome: join(root, "shared"), shadowRoot: join(root, "shadow"), defaultAuth: join(root, "none"), defaultHome: root, seedScript: "/nonexistent" };
    mkdirSync(paths.sharedHome);
    writeFileSync(join(paths.sharedHome, "config.toml"), fixtureConfig(fx.url));
    const accounts = join(root, "accounts");
    for (const a of ["0a000000-0000-4000-8000-00000000000a", "0b000000-0000-4000-8000-00000000000b"]) {
      mkdirSync(join(accounts, a), { recursive: true });
      writeFileSync(join(accounts, a, "auth.json"), '{"tokens":{}}');
    }
    const open = (account: string, forkFrom: string | null, events: BridgeEvent[]) => {
      const home = prepareShadowHome(account, accounts, paths);
      const s = openCodexSession({
        cwd: root, model: null, codexHome: home, baseEnv: { PATH: process.env.PATH, HOME: root }, resume: null, forkFrom,
        mcpConfigArgs: ["-c", 'cli_auth_credentials_store="file"', "-c", `sqlite_home=${JSON.stringify(join(home, "sqlite"))}`],
        developerInstructions: "", emit: (e) => events.push(e), logError: () => {},
      });
      cleanups.push(() => void s.close());
      return s;
    };
    const threadOf = (events: BridgeEvent[]) => (events.find((e) => e.type === "thread.native") as Extract<BridgeEvent, { type: "thread.native" }>).nativeThreadId;

    const first: BridgeEvent[] = [];
    const ended = open("0a000000-0000-4000-8000-00000000000a", null, first);
    await ended.ready;
    await ended.startTurn("run-1", "remember the colour blue", "user");
    await until(() => first.some((e) => e.type === "run.completed"));
    const thread = threadOf(first);
    await ended.close();
    await ended.ended;

    const second: BridgeEvent[] = [];
    const continued = open("0b000000-0000-4000-8000-00000000000b", thread, second);
    await continued.ready;
    const forked = threadOf(second);
    expect(forked).not.toBe(thread);
    await continued.startTurn("run-2", "which colour?", "user");
    await until(() => second.some((e) => e.type === "run.completed"));
    // The model got the ended session's conversation with the new message.
    const history = JSON.stringify(fx.requests[1].input);
    expect(history).toContain("remember the colour blue");
    expect(history).toContain("Noted: blue.");
    expect(history).toContain("which colour?");

    // A second continue while the first is still open: its own fork, the ended history, not the first fork's turn.
    const third: BridgeEvent[] = [];
    const again = open("0a000000-0000-4000-8000-00000000000a", thread, third);
    await again.ready;
    expect([thread, forked]).not.toContain(threadOf(third));
    await again.startTurn("run-3", "and now?", "user");
    await until(() => third.some((e) => e.type === "run.completed"));
    const history2 = JSON.stringify(fx.requests[2].input);
    expect(history2).toContain("remember the colour blue");
    expect(history2).not.toContain("which colour?");
  }, 90_000);
});
