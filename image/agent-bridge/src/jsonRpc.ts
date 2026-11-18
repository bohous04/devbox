// JSON-RPC over newline-delimited JSON, in the dialect of `codex app-server`: JSON-RPC 2.0 without the
// "jsonrpc" header, requests in both directions.

export class JsonRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

// Code we answer with when our handler for a server request fails (JSON-RPC "internal error").
const HANDLER_FAILED = -32603;
const METHOD_NOT_FOUND = -32601;

export type Id = number | string;

interface Pending {
  method: string;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

export class JsonRpcPeer {
  private nextId = 0;
  private pending = new Map<Id, Pending>();
  private closedReason: string | null = null;
  private notificationHandler: (method: string, params: any) => void = () => {};
  private requestHandler: ((method: string, params: any, id: Id) => Promise<unknown>) | null = null;

  // `write` receives one complete line including its trailing newline.
  constructor(
    private io: { write(line: string): void; onLine(cb: (line: string) => void): void },
    private logError: (msg: string) => void = (msg) => console.error(msg),
  ) {
    io.onLine((line) => this.receive(line));
  }

  request<T>(method: string, params: unknown): Promise<T> {
    if (this.closedReason !== null) return Promise.reject(new Error(`${method}: ${this.closedReason}`));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { method, resolve: resolve as (v: unknown) => void, reject });
      this.send({ id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.send({ method, params });
  }

  onNotification(cb: (method: string, params: any) => void): void {
    this.notificationHandler = cb;
  }

  // `id` is the server's request id, which later server messages may refer to.
  onRequest(cb: (method: string, params: any, id: Id) => Promise<unknown>): void {
    this.requestHandler = cb;
  }

  // Rejects every pending and later request with `reason` (the peer process is gone).
  close(reason: string): void {
    if (this.closedReason !== null) return;
    this.closedReason = reason;
    for (const p of this.pending.values()) p.reject(new Error(`${p.method}: ${reason}`));
    this.pending.clear();
  }

  private send(msg: Record<string, unknown>): void {
    this.io.write(JSON.stringify(msg) + "\n");
  }

  private receive(line: string): void {
    if (line.trim() === "") return;
    let msg: { id?: Id; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string } };
    try {
      msg = JSON.parse(line);
    } catch {
      this.logError(`json-rpc: unparseable line: ${line.slice(0, 200)}`);
      return;
    }
    if (typeof msg.method === "string" && msg.id !== undefined) void this.answer(msg.id, msg.method, msg.params);
    else if (typeof msg.method === "string") this.notificationHandler(msg.method, msg.params);
    else if (msg.id !== undefined) this.settle(msg.id, msg);
    else this.logError(`json-rpc: message is neither request, response nor notification: ${line.slice(0, 200)}`);
  }

  private settle(id: Id, msg: { result?: unknown; error?: { code: number; message: string } }): void {
    const p = this.pending.get(id);
    if (!p) {
      this.logError(`json-rpc: response for unknown id ${JSON.stringify(id)}`);
      return;
    }
    this.pending.delete(id);
    if (msg.error) p.reject(new JsonRpcError(msg.error.code, `${p.method}: ${msg.error.message}`));
    else p.resolve(msg.result);
  }

  private async answer(id: Id, method: string, params: unknown): Promise<void> {
    if (!this.requestHandler) {
      this.logError(`json-rpc: no handler for server request ${method}`);
      this.send({ id, error: { code: METHOD_NOT_FOUND, message: `client does not handle ${method}` } });
      return;
    }
    try {
      this.send({ id, result: await this.requestHandler(method, params, id) });
    } catch (e) {
      this.send({ id, error: { code: HANDLER_FAILED, message: e instanceof Error ? e.message : String(e) } });
    }
  }
}
