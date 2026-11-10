import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { InferenceError } from "@ai-colony/core";
import { OpenAICompatibleProvider } from "@ai-colony/inference";

describe("OpenAI-compatible inference", () => {
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
  });

  it("rejects a server model that does not match the requested alias", async () => {
    const baseUrl = await listen(servers, (response) => {
      response.end(JSON.stringify({ model: "other-model", choices: [{ message: { content: "hello" } }] }));
    });
    const provider = new OpenAICompatibleProvider({
      baseUrl,
      apiKey: null,
      maxConcurrency: 1,
      transportRetries: 0,
    });
    await expect(
      provider.generate({
        requestId: "1",
        registryModelId: "00000000-0000-4000-8000-000000000101",
        modelAlias: "qwen3-8b",
        messages: [{ role: "user", content: "ping" }],
        temperature: 0,
        maxOutputTokens: 16,
        timeoutMs: 1000,
        jsonObject: false,
      }),
    ).rejects.toMatchObject({ code: "identity_mismatch" } satisfies Partial<InferenceError>);
  });

  it("records observed token counts and reports a matching model", async () => {
    const baseUrl = await listen(servers, (response, request) => {
      if (request.url === "/v1/models") {
        response.end(JSON.stringify({ data: [{ id: "qwen3-8b" }] }));
        return;
      }
      response.end(
        JSON.stringify({
          model: "qwen3-8b",
          choices: [{ message: { content: "Solar needs storage." } }],
          usage: { prompt_tokens: 11, completion_tokens: 4 },
        }),
      );
    });
    const provider = new OpenAICompatibleProvider({
      baseUrl,
      apiKey: "local-token",
      maxConcurrency: 1,
      transportRetries: 0,
    });
    const probe = await provider.probe();
    expect(probe).toEqual({ reachable: true, modelIds: ["qwen3-8b"], error: null });
    const result = await provider.generate({
      requestId: "2",
      registryModelId: "00000000-0000-4000-8000-000000000101",
      modelAlias: "qwen3-8b",
      messages: [{ role: "user", content: "ping" }],
      temperature: 0,
      maxOutputTokens: 16,
      timeoutMs: 1000,
      jsonObject: false,
    });
    expect(result.servedModel).toBe("qwen3-8b");
    expect(result.usage).toEqual({ inputTokens: 11, outputTokens: 4, source: "observed" });
    expect(result.text).toBe("Solar needs storage.");
  });

  it("prefers json_schema structured output then falls back to json_object", async () => {
    const bodies: string[] = [];
    const baseUrl = await listen(servers, (response, request) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        bodies.push(body);
        if (body.includes('"type":"json_schema"')) {
          response.writeHead(400);
          response.end();
          return;
        }
        response.end(
          JSON.stringify({
            model: "qwen3:8b",
            choices: [{ message: { content: '{"kind":"response","body":"ok structured"}' } }],
            usage: { prompt_tokens: 3, completion_tokens: 2 },
          }),
        );
      });
    });
    const provider = new OpenAICompatibleProvider({
      baseUrl,
      apiKey: null,
      maxConcurrency: 1,
      transportRetries: 0,
    });
    const result = await provider.generate({
      requestId: "schema-1",
      registryModelId: "00000000-0000-4000-8000-000000000101",
      modelAlias: "qwen3:8b",
      messages: [{ role: "user", content: "ping" }],
      temperature: 0,
      maxOutputTokens: 32,
      timeoutMs: 1000,
      jsonObject: true,
      jsonSchema: {
        type: "object",
        properties: { kind: { type: "string" }, body: { type: "string" } },
        required: ["kind", "body"],
      },
    });
    expect(bodies.some((body) => body.includes('"type":"json_schema"'))).toBe(true);
    expect(bodies.some((body) => body.includes('"type":"json_object"'))).toBe(true);
    expect(result.text).toContain("ok structured");
  });

  it("retries without reasoning_effort when the server rejects that field", async () => {
    const bodies: string[] = [];
    const baseUrl = await listen(servers, (response, request) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        bodies.push(body);
        if (body.includes("reasoning_effort")) {
          response.writeHead(400);
          response.end();
          return;
        }
        response.end(
          JSON.stringify({
            model: "qwen3:8b",
            choices: [{ message: { content: "solar" } }],
            usage: { prompt_tokens: 3, completion_tokens: 1 },
          }),
        );
      });
    });
    const provider = new OpenAICompatibleProvider({
      baseUrl,
      apiKey: null,
      maxConcurrency: 1,
      transportRetries: 0,
    });
    const result = await provider.generate({
      requestId: "3",
      registryModelId: "00000000-0000-4000-8000-000000000101",
      modelAlias: "qwen3:8b",
      messages: [{ role: "user", content: "ping" }],
      temperature: 0,
      maxOutputTokens: 16,
      timeoutMs: 1000,
      jsonObject: false,
    });
    expect(bodies).toHaveLength(2);
    expect(result.servedModel).toBe("qwen3:8b");
    expect(result.text).toBe("solar");
  });
});

function listen(
  servers: Server[],
  handler: (response: ServerResponse, request: IncomingMessage) => void,
): Promise<string> {
  const server = createServer((request, response) => handler(response, request));
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Test server did not bind");
      }
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}
