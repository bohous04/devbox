import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { EventLog } from "../src/eventLog";
import type { BackgroundWork } from "../src/events";
import { createMcpServer, sendCommand } from "../src/mcp";
import { claudeMcpServers, codexMcpArgs } from "../src/prompts";
import { startServer } from "../src/server";
import { DeclaredWaits } from "../src/waits";

let dir: string;
let clock: number;
let changes: BackgroundWork[][];
let waits: DeclaredWaits;
let client: Client;
const closers: (() => unknown)[] = [];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "mcp-"));
  clock = 1_000_000;
  changes = [];
  waits = new DeclaredWaits(() => clock, (w) => changes.push(w));
  const socketPath = join(dir, "agent.sock");
  const server = startServer({
    socketPath,
    log: new EventLog(join(dir, "events.jsonl")),
    onCommand: async (cmd) => {
      if (cmd.kind === "declareWait") return waits.declare(cmd.reason, cmd.waitKind, cmd.timeoutMinutes);
      if (cmd.kind === "endWait") return void waits.clear();
      throw new Error(`unexpected ${cmd.kind}`);
    },
    handshake: () => ({ version: "test", awaitingTarget: false }),
    logError: () => {},
  });
  closers.push(() => server.close());
  const mcp = createMcpServer(socketPath);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await mcp.connect(a);
  client = new Client({ name: "test", version: "0" });
  await client.connect(b);
  closers.push(() => client.close());
});
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  rmSync(dir, { recursive: true, force: true });
});

const parse = (r: any) => JSON.parse(r.content[0].text);

test("devbox_wait declares holding work with until = now + timeout", async () => {
  const r: any = await client.callTool({ name: "devbox_wait", arguments: { reason: "bun test", kind: "command", timeoutMinutes: 30 } });
  expect(r.isError).toBeFalsy();
  expect(parse(r)).toEqual({ ok: true, until: clock + 30 * 60_000 });
  expect(waits.current()).toEqual([
    { id: "declared-wait", kind: "declared-wait", label: "command: bun test", holding: true, until: clock + 30 * 60_000 },
  ]);
  expect(changes.at(-1)).toEqual(waits.current());
});

test("default timeout is 60 minutes", async () => {
  const r: any = await client.callTool({ name: "devbox_wait", arguments: { reason: "ci run", kind: "ci" } });
  expect(parse(r).until).toBe(clock + 60 * 60_000);
});

test("timeout above 240 is rejected with a tool error", async () => {
  const r: any = await client.callTool({ name: "devbox_wait", arguments: { reason: "x", kind: "ci", timeoutMinutes: 241 } });
  expect(r.isError).toBe(true);
  expect(r.content[0].text).toContain("240");
  expect(waits.current()).toEqual([]);
});

test("devbox_wait_done clears it", async () => {
  await client.callTool({ name: "devbox_wait", arguments: { reason: "x", kind: "ci" } });
  const r: any = await client.callTool({ name: "devbox_wait_done", arguments: {} });
  expect(parse(r)).toEqual({ ok: true });
  expect(waits.current()).toEqual([]);
  expect(changes.at(-1)).toEqual([]);
});

test("an unreachable bridge is a tool error, not a default", async () => {
  const mcp = createMcpServer(join(dir, "missing.sock"));
  const [a, b] = InMemoryTransport.createLinkedPair();
  await mcp.connect(a);
  const c = new Client({ name: "t", version: "0" });
  await c.connect(b);
  const r: any = await c.callTool({ name: "devbox_wait_done", arguments: {} });
  expect(r.isError).toBe(true);
  await c.close();
});

/** A unix socket that accepts commands and answers each with `reply` (nothing when null). */
function fakeBridge(reply: string | null): string {
  const path = join(dir, "fake.sock");
  const l = Bun.listen({ unix: path, socket: { data(s) { if (reply !== null) s.write(reply); } } });
  closers.push(() => l.stop(true));
  return path;
}

test("a bridge that never answers fails the command after the timeout, it does not hang", async () => {
  const path = fakeBridge(null);
  const t0 = Date.now();
  await expect(sendCommand(path, { kind: "endWait" }, 100)).rejects.toThrow("did not answer endWait within 100 ms");
  expect(Date.now() - t0).toBeLessThan(2000);
});

test("a malformed frame from the bridge is an error result, not a crash", async () => {
  const path = fakeBridge("{not json\n");
  const logged: string[] = [];
  await expect(sendCommand(path, { kind: "endWait" }, 1000, (m) => logged.push(m))).rejects.toThrow("malformed frame");
  expect(logged).toEqual([expect.stringContaining("malformed frame")]);
});

test("expired declared wait is removed and background.changed emitted", () => {
  waits.declare("x", "command", 1);
  changes.length = 0;
  clock += 59_000;
  waits.sweep();
  expect(changes).toEqual([]);
  clock += 1_000;
  waits.sweep();
  expect(waits.current()).toEqual([]);
  expect(changes).toEqual([[]]);
});

test("mcp config helpers forward the devd env that is set and omit the rest", () => {
  const saved = { ...process.env };
  try {
    process.env.DEVD_URL = "http://devd:4300";
    process.env.DEVD_SESSION_ID = "dev-x";
    delete process.env.DEVD_AGENT_SOCK;
    expect(claudeMcpServers()).toEqual({
      devbox: { type: "stdio", command: "agent-bridge", args: ["mcp"], env: { DEVD_URL: "http://devd:4300", DEVD_SESSION_ID: "dev-x" } },
    });
    expect(codexMcpArgs()).toEqual([
      "-c", 'mcp_servers.devbox.command="agent-bridge"', "-c", 'mcp_servers.devbox.args=["mcp"]',
      "-c", 'mcp_servers.devbox.env_vars=["DEVD_URL","DEVD_SESSION_ID"]',
    ]);
    delete process.env.DEVD_URL;
    expect((claudeMcpServers().devbox as { env: object }).env).toEqual({ DEVD_SESSION_ID: "dev-x" });
  } finally {
    process.env = saved;
  }
});

// --- devbox_thread_read ---
type FakeItem = { seq: number; kind: string; text: string; tool?: string; input?: unknown; output?: string };
function threadClient(all: FakeItem[], calls: string[] = []) {
  const fake = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    calls.push(`${u.pathname}${u.search}|${(init?.headers as Record<string, string>)["x-devbox-session"]}`);
    const before = u.searchParams.has("beforeSeq") ? Number(u.searchParams.get("beforeSeq")) : Infinity;
    const limit = Number(u.searchParams.get("limit"));
    const items = all.filter((i) => i.seq < before).slice(-limit);
    return Response.json({ items });
  }) as unknown as typeof fetch;
  return (async () => {
    const mcp = createMcpServer(join(dir, "none.sock"), { url: "http://devd:4300/", sessionId: "dev-x", fetch: fake });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await mcp.connect(a);
    const c = new Client({ name: "t", version: "0" });
    await c.connect(b);
    closers.push(() => c.close());
    return c;
  })();
}
const msgs = (n: number): FakeItem[] => Array.from({ length: n }, (_, k) => ({ seq: k + 1, kind: k % 2 ? "assistant" : "user", text: `message ${k + 1}` }));
const read = async (c: Client, args: Record<string, unknown>) => parse(await c.callTool({ name: "devbox_thread_read", arguments: args }));

test("thread_read pages newest-first with nextBeforeSeq and a default limit of 20", async () => {
  const calls: string[] = [];
  const c = await threadClient(msgs(45), calls);
  const p1 = await read(c, {});
  expect(p1.items).toHaveLength(20);
  expect(p1.items[0]).toBe("[45] user: message 45");
  expect(p1.nextBeforeSeq).toBe(26);
  expect(calls[0]).toBe("/api/sessions/dev-x/thread?limit=100|dev-x");
  const p2 = await read(c, { beforeSeq: p1.nextBeforeSeq });
  expect(p2.items[0]).toBe("[25] user: message 25");
  expect(p2.nextBeforeSeq).toBe(6);
  const p3 = await read(c, { beforeSeq: p2.nextBeforeSeq });
  expect(p3.items).toHaveLength(5);
  expect(p3.nextBeforeSeq).toBeNull();
});

test("thread_read limit above 50 is a tool error; 50 is allowed", async () => {
  const c = await threadClient(msgs(60));
  const bad: any = await c.callTool({ name: "devbox_thread_read", arguments: { limit: 51 } });
  expect(bad.isError).toBe(true);
  expect((await read(c, { limit: 50 })).items).toHaveLength(50);
});

test("thread_read query is a case-insensitive substring filter and scans past one page", async () => {
  const all = msgs(250);
  all[9]!.text = "Deploy the FOO service";
  all[199]!.text = "foo again";
  const c = await threadClient(all);
  const r = await read(c, { query: "foo" });
  expect(r.items).toEqual(["[200] assistant: foo again", "[10] assistant: Deploy the FOO service"]);
  expect(r.nextBeforeSeq).toBeNull();
});

test("thread_read keeps items that share a seq (notice after an item) across pages", async () => {
  const all: FakeItem[] = [];
  for (let s = 1; s <= 30; s++) { all.push({ seq: s, kind: "user", text: `m${s}` }); all.push({ seq: s, kind: "notice", text: `n${s}` }); }
  const c = await threadClient(all);
  const seen: string[] = [];
  let before: number | undefined;
  for (let guard = 0; guard < 20; guard++) {
    const r = await read(c, before === undefined ? { limit: 7 } : { limit: 7, beforeSeq: before });
    seen.push(...r.items);
    if (r.nextBeforeSeq === null) break;
    before = r.nextBeforeSeq;
  }
  expect(seen).toHaveLength(60);
  expect(new Set(seen).size).toBe(60);
});

test("thread_read renders tool items with the command and the first 2 KB of output", async () => {
  const c = await threadClient([{ seq: 1, kind: "tool", text: "", tool: "Bash", input: { command: "ls -la" }, output: "x".repeat(3000) }]);
  const [line] = (await read(c, {})).items as string[];
  expect(line.startsWith("[1] tool Bash: ls -la\n")).toBe(true);
  expect(line).toContain("x".repeat(2048));
  expect(line).not.toContain("x".repeat(2049));
  expect(line).toContain("[output truncated, 3000 bytes]");
});

test("thread_read without devd access is a tool error, not a silent empty result", async () => {
  const r: any = await client.callTool({ name: "devbox_thread_read", arguments: {} });
  expect(r.isError).toBe(true);
  expect(r.content[0].text).toContain("DEVD_URL");
});

test("thread_read query scan is bounded and returns a cursor to continue", async () => {
  const all = msgs(5000);
  all[0]!.text = "needle";
  const c = await threadClient(all);
  const r1 = await read(c, { query: "needle" });
  expect(r1.items).toEqual([]);
  expect(typeof r1.nextBeforeSeq).toBe("number");
  let r = r1;
  for (let g = 0; g < 5 && r.nextBeforeSeq !== null && r.items.length === 0; g++) r = await read(c, { query: "needle", beforeSeq: r.nextBeforeSeq });
  expect(r.items).toEqual(["[1] user: needle"]);
});
