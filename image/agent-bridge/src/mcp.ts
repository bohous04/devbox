import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { encodeFrame, type BridgeCommand, type ServerFrame } from "./protocol";

export const DEFAULT_SOCKET = "/run/devd/agent.sock";

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
];

/** One connection per command: the bridge accepts `cmd` frames without `hello`. */
export function sendCommand(socketPath: string, cmd: BridgeCommand): Promise<unknown> {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    let buf = "";
    let settled = false;
    const decoder = new TextDecoder();
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    Bun.connect({
      unix: socketPath,
      socket: {
        open(socket) {
          socket.write(encodeFrame({ t: "cmd", id, cmd }));
        },
        data(socket, chunk) {
          buf += decoder.decode(chunk, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const frame = JSON.parse(buf.slice(0, nl)) as ServerFrame;
            buf = buf.slice(nl + 1);
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

const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], isError });

export function createMcpServer(socketPath: string): Server {
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
      return text(`unknown tool: ${req.params.name}`, true);
    } catch (err) {
      return text(err instanceof Error ? err.message : String(err), true);
    }
  });
  return server;
}

/** Entry for `agent-bridge mcp`: stdio MCP server talking to the bridge socket. */
export async function runMcp(): Promise<void> {
  await createMcpServer(process.env.DEVD_AGENT_SOCK ?? DEFAULT_SOCKET).connect(new StdioServerTransport());
}
