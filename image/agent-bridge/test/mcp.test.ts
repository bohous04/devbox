import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { EventLog } from "../src/eventLog";
import type { BackgroundWork } from "../src/events";
import { createMcpServer } from "../src/mcp";
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

test("mcp config helpers", () => {
  expect(claudeMcpServers()).toEqual({ devbox: { type: "stdio", command: "agent-bridge", args: ["mcp"] } });
  expect(codexMcpArgs()).toEqual(["-c", 'mcp_servers.devbox.command="agent-bridge"', "-c", 'mcp_servers.devbox.args=["mcp"]']);
});
