// The Codex adapter against the real `codex app-server` binary, with every model request going to a loopback
// Responses fixture: no account, no network, a fresh CODEX_HOME. Skipped where codex is not installed (CI).
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

function codexHome(url: string): string {
  const home = mkdtempSync(join(tmpdir(), "codex-live-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  writeFileSync(join(home, "config.toml"), [
    'model = "gpt-5.4"', 'model_provider = "fixture"',
    "[model_providers.fixture]", 'name = "Loopback fixture"', `base_url = ${JSON.stringify(url)}`,
    'wire_api = "responses"', "requires_openai_auth = false", "supports_websockets = false", "",
  ].join("\n"));
  return home;
}

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
      { type: "message", id: "msg_1", role: "assistant", content: [{ type: "output_text", text: "Using SQLite." }] },
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
});
