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
          choices: [{ finish_reason: "stop", message: { content: "Solar needs storage." } }],
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

  it("disables thinking with reasoning_effort none and does not fall back to uncontrolled OpenAI", async () => {
    const bodies: Array<{ path: string; body: string }> = [];
    const baseUrl = await listen(servers, (response, request) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        bodies.push({ path: request.url ?? "", body });
        if (body.includes('"reasoning_effort"')) {
          response.writeHead(400);
          response.end();
          return;
        }
        if (body.includes('"reasoning":{') && body.includes('"effort":"none"')) {
          response.end(
            JSON.stringify({
              model: "qwen3:8b",
              choices: [{ finish_reason: "stop", message: { content: "4", reasoning: "" } }],
              usage: { prompt_tokens: 3, completion_tokens: 1 },
            }),
          );
          return;
        }
        response.writeHead(500);
        response.end("unexpected uncontrolled call");
      });
    });
    const provider = new OpenAICompatibleProvider({
      baseUrl,
      apiKey: null,
      maxConcurrency: 1,
      transportRetries: 0,
      thinking: "disabled",
    });
    const result = await provider.generate({
      requestId: "think-off",
      registryModelId: "00000000-0000-4000-8000-000000000101",
      modelAlias: "qwen3:8b",
      messages: [{ role: "user", content: "2+2" }],
      temperature: 0,
      maxOutputTokens: 16,
      timeoutMs: 1000,
      jsonObject: false,
      thinking: "disabled",
    });
    expect(bodies[0]?.body).toContain('"reasoning_effort":"none"');
    expect(bodies.some((row) => row.body.includes('"effort":"none"'))).toBe(true);
    expect(bodies.every((row) => row.path.includes("/v1/chat/completions") || row.path.includes("/api/chat"))).toBe(true);
    expect(result.text).toBe("4");
    expect(result.reasoningPresent).toBe(false);
  });

  it("explicitly enables thinking and preserves the requested output budget", async () => {
    const bodies: string[] = [];
    const baseUrl = await listen(servers, (response, request) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        bodies.push(body);
        if (request.url === "/api/chat") {
          const parsed = JSON.parse(body) as { think?: boolean; options?: { num_predict?: number } };
          expect(parsed.think).toBe(true);
          expect(parsed.options?.num_predict).toBe(1024);
          response.end(
            JSON.stringify({
              model: "qwen3:8b",
              message: { content: "FINAL: 4", thinking: "stepwise draft" },
              done_reason: "stop",
              prompt_eval_count: 10,
              eval_count: 6,
            }),
          );
          return;
        }
        response.writeHead(500);
        response.end("openai path should not be required when native succeeds");
      });
    });
    const provider = new OpenAICompatibleProvider({
      baseUrl,
      apiKey: null,
      maxConcurrency: 1,
      transportRetries: 0,
      thinking: "enabled",
    });
    const result = await provider.generate({
      requestId: "think-on",
      registryModelId: "00000000-0000-4000-8000-000000000101",
      modelAlias: "qwen3:8b",
      messages: [{ role: "user", content: "2+2" }],
      temperature: 0,
      maxOutputTokens: 1024,
      timeoutMs: 1000,
      jsonObject: false,
      thinking: "enabled",
    });
    expect(bodies.some((body) => body.includes('"think":true') && body.includes('"num_predict":1024'))).toBe(true);
    expect(result.text).toBe("FINAL: 4");
    expect(result.reasoningPresent).toBe(true);
    expect(result.text).not.toContain("stepwise draft");
  });

  it("treats thinking-only length responses as empty answers without crashing", async () => {
    const baseUrl = await listen(servers, (response, request) => {
      if (request.url === "/api/chat") {
        response.end(
          JSON.stringify({
            model: "qwen3:8b",
            message: {
              content: "",
              thinking: "The model spent the whole budget thinking about arithmetic...",
            },
            done_reason: "length",
            prompt_eval_count: 20,
            eval_count: 256,
          }),
        );
        return;
      }
      response.end(
        JSON.stringify({
          model: "qwen3:8b",
          choices: [
            {
              finish_reason: "length",
              message: {
                content: "",
                reasoning: "The model spent the whole budget thinking about arithmetic...",
              },
            },
          ],
          usage: { prompt_tokens: 20, completion_tokens: 256 },
        }),
      );
    });
    const provider = new OpenAICompatibleProvider({
      baseUrl,
      apiKey: null,
      maxConcurrency: 1,
      transportRetries: 0,
      thinking: "enabled",
    });
    const result = await provider.generate({
      requestId: "think-only",
      registryModelId: "00000000-0000-4000-8000-000000000101",
      modelAlias: "qwen3:8b",
      messages: [{ role: "user", content: "17*19" }],
      temperature: 0,
      maxOutputTokens: 256,
      timeoutMs: 1000,
      jsonObject: false,
      thinking: "enabled",
    });
    expect(result.text).toBe("");
    expect(result.finishReason).toBe("length");
    expect(result.truncated).toBe(true);
    expect(result.reasoningPresent).toBe(true);
    expect(result.usage.outputTokens).toBe(256);
    // Reasoning must never become the scored answer.
    expect(result.text).not.toContain("thinking about arithmetic");
  });

  it("still rejects malformed responses that lack model identity", async () => {
    const baseUrl = await listen(servers, (response) => {
      response.end(JSON.stringify({ choices: [{ message: { content: "orphan" } }] }));
    });
    const provider = new OpenAICompatibleProvider({
      baseUrl,
      apiKey: null,
      maxConcurrency: 1,
      transportRetries: 0,
    });
    await expect(
      provider.generate({
        requestId: "bad",
        registryModelId: "00000000-0000-4000-8000-000000000101",
        modelAlias: "qwen3:8b",
        messages: [{ role: "user", content: "ping" }],
        temperature: 0,
        maxOutputTokens: 8,
        timeoutMs: 1000,
        jsonObject: false,
      }),
    ).rejects.toMatchObject({ code: "bad_response" } satisfies Partial<InferenceError>);
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
