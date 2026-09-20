import {
  JsonRpcClient,
  type JsonRpcHandlers,
  type JsonRpcId,
  type JsonRpcMessage,
} from "./jsonRpc";

export type { JsonRpcMessage };

export type AcpHandlers = {
  onNotification?: (method: string, params: unknown) => void;
  onRequest?: (
    id: JsonRpcId,
    method: string,
    params: unknown,
  ) => void | Promise<void>;
};

/**
 * ACP JSON-RPC client. Server request ids are passed through untouched so
 * respond() echoes back the exact id — coercing a string id to number would
 * serialize `null` and leave the agent's request hanging.
 */
export class AcpClient {
  private readonly rpc: JsonRpcClient;
  private readonly prompts = new Set<Promise<unknown>>();
  private questions: Promise<void> = Promise.resolve();
  private questionGeneration = 0;

  constructor(
    sessionId: string,
    private readonly handlers: AcpHandlers,
  ) {
    const rpcHandlers: JsonRpcHandlers = {
      onNotification: (method, params) =>
        this.handlers.onNotification?.(method, params),
      onRequest: (id, method, params) => {
        void this.handlers.onRequest?.(id, method, params);
      },
    };
    this.rpc = new JsonRpcClient(sessionId, rpcHandlers, {
      includeJsonrpc: true,
      label: "acp",
    });
  }

  pushLine(line: string) {
    this.rpc.pushLine(line);
  }

  close(error?: Error) {
    this.questionGeneration += 1;
    this.rpc.close(error);
  }

  rejectPending(error?: Error) {
    this.questionGeneration += 1;
    this.rpc.rejectPending(error);
  }

  /** The composer presents one question at a time; cancelled queued asks still get a reply. */
  queueQuestion(run: (cancelled: boolean) => Promise<void>): Promise<void> {
    const generation = this.questionGeneration;
    const pending = this.questions.catch(() => undefined)
      .then(() => run(generation !== this.questionGeneration));
    this.questions = pending;
    return pending;
  }

  request<T>(method: string, params?: unknown, timeoutMs = 0): Promise<T> {
    const request = this.rpc.request<T>(method, params, timeoutMs);
    if (method === "session/prompt") {
      this.prompts.add(request);
      const remove = () => { this.prompts.delete(request); };
      request.then(remove, remove);
    }
    return request;
  }

  /** A turn includes every follow-up accepted before it becomes idle. */
  async waitForPrompts(): Promise<void> {
    while (this.prompts.size) await Promise.all([...this.prompts]);
  }

  notify(method: string, params?: unknown): Promise<void> {
    return this.rpc.notify(method, params);
  }

  respond(id: JsonRpcId, result: unknown): Promise<void> {
    return this.rpc.respond(id, result);
  }

  respondError(
    id: JsonRpcId,
    error: { code: number; message: string; data?: unknown },
  ): Promise<void> {
    return this.rpc.respondError(id, error);
  }
}
