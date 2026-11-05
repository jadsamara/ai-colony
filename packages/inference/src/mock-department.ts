import { createServer, type Server } from "node:http";

export interface MockDepartmentRequest {
  url: string;
  body: unknown;
}

export class MockDepartmentServer {
  readonly requests: MockDepartmentRequest[] = [];
  private server: Server | null = null;
  private queue: string[] = [];
  failing = false;
  failAfter: number | null = null;
  private successes = 0;
  port = 0;

  constructor(
    readonly instanceId: string,
    readonly departmentId: string,
  ) {}

  enqueue(content: string): void {
    this.queue.push(content);
  }

  resetCounters(): void {
    this.requests.length = 0;
    this.successes = 0;
    this.failing = false;
    this.failAfter = null;
    this.queue.length = 0;
  }

  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let body: unknown = {};
        try {
          body = raw ? JSON.parse(raw) : {};
        } catch {
          body = { raw };
        }
        this.requests.push({ url: request.url ?? "", body });
        if (this.failing || (this.failAfter !== null && this.successes >= this.failAfter)) {
          response.writeHead(503, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "unavailable" }));
          return;
        }
        this.successes += 1;
        const content = this.queue.shift() ?? JSON.stringify({ type: "final", text: "ok" });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          model: this.instanceId,
          choices: [{ message: { content } }],
          usage: { total_tokens: 8 },
        }));
      });
    });
    await new Promise<void>((resolve) => {
      this.server?.listen(0, "127.0.0.1", () => resolve());
    });
    const address = this.server.address();
    this.port = typeof address === "object" && address ? address.port : 0;
  }

  endpoint(): string {
    return `http://127.0.0.1:${this.port}/v1`;
  }

  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }
    const server = this.server;
    this.server = null;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}
