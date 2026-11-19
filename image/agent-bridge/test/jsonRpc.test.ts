import { describe, expect, test } from "bun:test";
import { JsonRpcError, JsonRpcPeer } from "../src/jsonRpc.ts";

function pipe() {
  const written: Record<string, unknown>[] = [];
  let deliver: ((line: string) => void) | null = null;
  const logs: string[] = [];
  const peer = new JsonRpcPeer(
    {
      write: (line) => written.push(JSON.parse(line)),
      onLine: (cb) => (deliver = cb),
    },
    (m) => logs.push(m),
  );
  return { peer, written, logs, receive: (msg: unknown) => deliver!(typeof msg === "string" ? msg : JSON.stringify(msg)) };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("JsonRpcPeer", () => {
  test("request resolves with the matching id", async () => {
    const { peer, written, receive } = pipe();
    const a = peer.request<{ n: number }>("a", { x: 1 });
    const b = peer.request<{ n: number }>("b", {});
    expect(written).toEqual([
      { id: 0, method: "a", params: { x: 1 } },
      { id: 1, method: "b", params: {} },
    ]);
    receive({ id: 1, result: { n: 2 } });
    receive({ id: 0, result: { n: 1 } });
    expect(await a).toEqual({ n: 1 });
    expect(await b).toEqual({ n: 2 });
  });

  test("error response rejects with code and message", async () => {
    const { peer, receive } = pipe();
    const p = peer.request("thread/resume", { threadId: "t" });
    receive({ id: 0, error: { code: -32600, message: "no rollout found" } });
    const err = (await p.catch((e) => e)) as JsonRpcError;
    expect(err).toBeInstanceOf(JsonRpcError);
    expect(err.code).toBe(-32600);
    expect(err.message).toBe("thread/resume: no rollout found");
  });

  test("server request gets the handler's result", async () => {
    const { peer, written, receive } = pipe();
    peer.onRequest(async (method, params) => ({ method, echo: params }));
    receive({ id: "srv-1", method: "item/tool/requestUserInput", params: { q: 1 } });
    await flush();
    expect(written).toEqual([{ id: "srv-1", result: { method: "item/tool/requestUserInput", echo: { q: 1 } } }]);
  });

  test("a failing server request handler answers with an error", async () => {
    const { peer, written, receive } = pipe();
    peer.onRequest(async () => {
      throw new Error("unsupported");
    });
    receive({ id: 7, method: "item/tool/call", params: {} });
    await flush();
    expect(written).toEqual([{ id: 7, error: { code: -32603, message: "unsupported" } }]);
  });

  test("a handler returning no result answers with an error and logs", async () => {
    const { peer, written, receive, logs } = pipe();
    peer.onRequest(async () => undefined);
    receive({ id: 3, method: "item/tool/requestUserInput", params: {} });
    await flush();
    expect(written).toEqual([{ id: 3, error: { code: -32603, message: "handler for item/tool/requestUserInput returned no result" } }]);
    expect(logs.some((l) => l.includes("item/tool/requestUserInput"))).toBe(true);
  });

  test("notification reaches onNotification", () => {
    const { peer, written, receive } = pipe();
    const seen: [string, unknown][] = [];
    peer.onNotification((method, params) => seen.push([method, params]));
    receive({ method: "turn/started", params: { threadId: "t" } });
    peer.notify("initialized", undefined);
    expect(seen).toEqual([["turn/started", { threadId: "t" }]]);
    expect(written).toEqual([{ method: "initialized" }]);
  });

  test("unparseable lines and unknown response ids are logged", () => {
    const { receive, logs } = pipe();
    receive("{not json");
    receive({ id: 99, result: {} });
    expect(logs).toHaveLength(2);
    expect(logs[0]).toContain("unparseable");
    expect(logs[1]).toContain("99");
  });

  test("close rejects pending and later requests", async () => {
    const { peer } = pipe();
    const p = peer.request("turn/start", {});
    peer.close("codex app-server exited with code 1");
    expect(await p.catch((e) => e.message)).toBe("turn/start: codex app-server exited with code 1");
    expect(await peer.request("turn/interrupt", {}).catch((e) => e.message)).toBe("turn/interrupt: codex app-server exited with code 1");
  });
  test("the JSON-RPC 2.0 dialect stamps every message it writes", async () => {
    const written: Record<string, unknown>[] = [];
    let deliver: ((line: string) => void) | null = null;
    const peer = new JsonRpcPeer({ write: (line) => written.push(JSON.parse(line)), onLine: (cb) => (deliver = cb) }, () => {}, { jsonrpc: "2.0" });
    peer.onRequest(async () => ({ ok: true }));
    const r = peer.request("initialize", {});
    peer.notify("session/cancel", { sessionId: "s" });
    deliver!(JSON.stringify({ jsonrpc: "2.0", id: "agent-1", method: "session/request_permission", params: {} }));
    deliver!(JSON.stringify({ jsonrpc: "2.0", id: 0, result: { protocolVersion: 1 } }));
    expect(await r).toEqual({ protocolVersion: 1 });
    await flush();
    expect(written).toEqual([
      { jsonrpc: "2.0", id: 0, method: "initialize", params: {} },
      { jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "s" } },
      { jsonrpc: "2.0", id: "agent-1", result: { ok: true } },
    ]);
  });
});
