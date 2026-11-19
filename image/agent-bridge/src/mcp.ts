import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { encodeFrame, type BridgeCommand, type ServerFrame } from "./protocol";

export const DEFAULT_SOCKET = "/run/devd/agent.sock";

const THREAD_READ_DEFAULT = 20;
const THREAD_READ_MAX = 50;
/** Items fetched from devd per request while scanning for `query` matches. */
const THREAD_PAGE = 100;
/** A `query` scan stops after this many items and hands back a cursor to continue from. */
const THREAD_SCAN_MAX = 2000;
const THREAD_TOOL_OUTPUT_BYTES = 2048;
const DEVD_TIMEOUT_MS = 30_000;

export interface DevdAccess { url: string; sessionId: string; fetch?: typeof fetch }

interface ThreadItemView { seq: number; kind: string; text: string; tool?: string; input?: unknown; output?: string }

const TOOLS = [
  {
    name: "devbox_wait",
    description:
      "Declare that you are waiting for a background command or CI before ending your turn, so devbox keeps the session marked as working. Expires after timeoutMinutes.",
    inputSchema: {
      type: "object",
      properties: {
        reason: { type: "string", minLength: 1, description: "What you are waiting for." },
        kind: { type: "string", enum: ["command", "ci"] },
        timeoutMinutes: { type: "number", exclusiveMinimum: 0, maximum: 240, description: "Default 60, max 240." },
      },
      required: ["reason", "kind"],
      additionalProperties: false,
    },
  },
  {
    name: "devbox_wait_done",
    description: "Clear the wait declared with devbox_wait; call it when you stop waiting.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "devbox_thread_read",
    description:
      "Read older messages of this session's conversation (after a context handoff left history out). Newest first, as `[seq] role: text`. Pass nextBeforeSeq from the previous result as beforeSeq to page further back.",
    inputSchema: {
      type: "object",
      properties: {
        beforeSeq: { type: "integer", minimum: 0, description: "Only items older than this seq." },
        limit: { type: "integer", minimum: 1, maximum: THREAD_READ_MAX, description: `Items to return, default ${THREAD_READ_DEFAULT}, max ${THREAD_READ_MAX}.` },
        query: { type: "string", minLength: 1, description: "Only items whose text contains this (case-insensitive)." },
      },
      additionalProperties: false,
    },
  },
];

/** How long the MCP server waits for the bridge's answer: a stuck bridge must not hang the agent's tool call. */
export const BRIDGE_COMMAND_TIMEOUT_MS = 30_000;

/** One connection per command: the bridge accepts `cmd` frames without `hello`. Rejects (never hangs) when the
 *  bridge does not answer within `timeoutMs` or sends a frame that is not JSON. */
export function sendCommand(
  socketPath: string,
  cmd: BridgeCommand,
  timeoutMs = BRIDGE_COMMAND_TIMEOUT_MS,
  logError: (msg: string) => void = (msg) => console.error(msg),
): Promise<unknown> {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    let buf = "";
    let settled = false;
    let conn: { end(): void } | null = null;
    const decoder = new TextDecoder();
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      finish(() => reject(new Error(`agent bridge did not answer ${cmd.kind} within ${timeoutMs} ms`)));
      conn?.end();
    }, timeoutMs);
    Bun.connect({
      unix: socketPath,
      socket: {
        open(socket) {
          conn = socket;
          socket.write(encodeFrame({ t: "cmd", id, cmd }));
        },
        data(socket, chunk) {
          buf += decoder.decode(chunk, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            let frame: ServerFrame;
            try {
              frame = JSON.parse(line) as ServerFrame;
            } catch {
              const msg = `agent bridge sent a malformed frame for ${cmd.kind}: ${line.slice(0, 200)}`;
              logError(`devbox mcp: ${msg}`);
              finish(() => reject(new Error(msg)));
              socket.end();
              return;
            }
            if (frame.t !== "res" || frame.id !== id) continue;
            finish(() => (frame.ok ? resolve(frame.result) : reject(new Error(frame.error ?? "command failed"))));
            socket.end();
          }
        },
        close() {
          finish(() => reject(new Error("agent bridge closed the connection before answering")));
        },
        error(_socket, err) {
          finish(() => reject(err));
        },
      },
    }).catch((err) => finish(() => reject(new Error(`cannot reach the agent bridge at ${socketPath}: ${err.message}`))));
  });
}

function renderItem(i: ThreadItemView): string {
  if (i.kind !== "tool") return `[${i.seq}] ${i.kind}: ${i.text}`;
  const input = i.input as { command?: unknown } | string | undefined;
  const cmd = typeof input === "string" ? input : typeof input?.command === "string" ? input.command : JSON.stringify(input ?? {});
  const bytes = new TextEncoder().encode(i.output ?? "");
  const out = bytes.length > THREAD_TOOL_OUTPUT_BYTES
    ? `${new TextDecoder().decode(bytes.slice(0, THREAD_TOOL_OUTPUT_BYTES))}\n[output truncated, ${bytes.length} bytes]`
    : i.output ?? "";
  return `[${i.seq}] tool ${i.tool ?? ""}: ${cmd}${out ? `\n${out}` : ""}`;
}

/** Newest-first page of the thread through devd. Scans back in pages of THREAD_PAGE for `query` matches; ends a
 *  result on a seq boundary (devd notices share the seq of the item before them) so paging by seq loses nothing. */
export async function readThread(devd: DevdAccess, args: { beforeSeq?: number; limit: number; query?: string }) {
  const doFetch = devd.fetch ?? fetch;
  const needle = args.query?.toLowerCase();
  const matches: ThreadItemView[] = [];
  let cursor = args.beforeSeq;
  let next: number | null = null;
  let scanned = 0;
  for (;;) {
    const qs = new URLSearchParams({ limit: String(THREAD_PAGE) });
    if (cursor !== undefined) qs.set("beforeSeq", String(cursor));
    const res = await doFetch(`${devd.url.replace(/\/$/, "")}/api/sessions/${encodeURIComponent(devd.sessionId)}/thread?${qs}`, {
      headers: { "x-devbox-session": devd.sessionId },
      signal: AbortSignal.timeout(DEVD_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`devd answered ${res.status} for the thread: ${(await res.text()).slice(0, 200)}`);
    let items = ((await res.json()) as { items: ThreadItemView[] }).items;
    const full = items.length === THREAD_PAGE;
    if (full) {
      // The oldest seq of a full page may continue on the next one: hold it back and refetch it with that page.
      const oldest = items[0]!.seq;
      items = items.filter((i) => i.seq !== oldest);
      if (items.length === 0) throw new Error(`thread page of ${THREAD_PAGE} items all share seq ${oldest}`);
      cursor = oldest + 1;
    }
    scanned += items.length;
    for (const i of items.reverse()) {
      if (needle && !`${i.text}\n${i.output ?? ""}`.toLowerCase().includes(needle)) continue;
      matches.push(i);
    }
    if (matches.length >= args.limit) {
      const lastSeq = matches[args.limit - 1]!.seq;
      let end = args.limit;
      while (end < matches.length && matches[end]!.seq === lastSeq) end++;
      if (end < matches.length || full) next = lastSeq;
      matches.length = end;
      break;
    }
    if (!full) break;
    // Scan budget spent: return what was found; `cursor` re-includes the held-back seq group.
    if (scanned >= THREAD_SCAN_MAX) { next = cursor!; break; }
  }
  return { items: matches.map(renderItem), nextBeforeSeq: next };
}

const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], isError });

export function createMcpServer(socketPath: string, devd?: DevdAccess): Server {
  const server = new Server({ name: "devbox", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    try {
      if (req.params.name === "devbox_wait") {
        const { reason, kind, timeoutMinutes } = args;
        if (typeof reason !== "string" || reason === "") return text("reason must be a non-empty string", true);
        if (kind !== "command" && kind !== "ci") return text('kind must be "command" or "ci"', true);
        if (timeoutMinutes !== undefined && typeof timeoutMinutes !== "number") return text("timeoutMinutes must be a number", true);
        const result = (await sendCommand(socketPath, { kind: "declareWait", reason, waitKind: kind, timeoutMinutes })) as { until: number };
        return text(JSON.stringify({ ok: true, until: result.until }));
      }
      if (req.params.name === "devbox_wait_done") {
        await sendCommand(socketPath, { kind: "endWait" });
        return text(JSON.stringify({ ok: true }));
      }
      if (req.params.name === "devbox_thread_read") {
        if (!devd) return text("DEVD_URL and DEVD_SESSION_ID are not set; the thread cannot be read", true);
        const { beforeSeq, limit = THREAD_READ_DEFAULT, query } = args;
        if (beforeSeq !== undefined && !(Number.isSafeInteger(beforeSeq) && (beforeSeq as number) >= 0)) return text("beforeSeq must be a non-negative integer", true);
        if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > THREAD_READ_MAX) return text(`limit must be an integer between 1 and ${THREAD_READ_MAX}`, true);
        if (query !== undefined && (typeof query !== "string" || query === "")) return text("query must be a non-empty string", true);
        const r = await readThread(devd, { beforeSeq: beforeSeq as number | undefined, limit, query });
        return text(JSON.stringify(r));
      }
      return text(`unknown tool: ${req.params.name}`, true);
    } catch (err) {
      return text(err instanceof Error ? err.message : String(err), true);
    }
  });
  return server;
}

/** Entry for `agent-bridge mcp`: stdio MCP server talking to the bridge socket. */
export async function runMcp(): Promise<void> {
  const { DEVD_URL, DEVD_SESSION_ID } = process.env;
  const devd = DEVD_URL && DEVD_SESSION_ID ? { url: DEVD_URL, sessionId: DEVD_SESSION_ID } : undefined;
  await createMcpServer(process.env.DEVD_AGENT_SOCK ?? DEFAULT_SOCKET, devd).connect(new StdioServerTransport());
}
