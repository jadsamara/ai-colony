import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seed } from "@ai-colony/database";
import { auth, createTestApp } from "../helpers/app.js";
import { testDb } from "../helpers/db.js";

const SCIENCE = "00000000-0000-4000-8000-000000000205";
const SCIENCE_DEPARTMENT = "00000000-0000-4000-8000-00000000001b";
const MATH_DEPARTMENT = "00000000-0000-4000-8000-000000000019";

describe("C1.7.1 department conversation API routes", () => {
  let mockInference: Server;
  let previousBaseUrl: string | undefined;
  let previousAlias: string | undefined;

  beforeAll(async () => {
    previousBaseUrl = process.env.INFERENCE_BASE_URL;
    previousAlias = process.env.INFERENCE_MODEL_ALIAS;
    mockInference = createServer((request, response) => {
      if (request.method === "GET" && request.url === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "qwen3-8b" }] }));
        return;
      }
      if (request.method === "POST" && request.url === "/v1/chat/completions") {
        let body = "";
        request.on("data", (chunk) => {
          body += chunk;
        });
        request.on("end", () => {
          void body;
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              id: "chatcmpl-c171",
              model: "qwen3-8b",
              choices: [
                {
                  message: { role: "assistant", content: "Opening turn from mock inference." },
                  finish_reason: "stop",
                },
              ],
              usage: { prompt_tokens: 8, completion_tokens: 6, total_tokens: 14 },
            }),
          );
        });
        return;
      }
      response.writeHead(404);
      response.end();
    });
    await new Promise<void>((resolve) => {
      mockInference.listen(0, "127.0.0.1", () => resolve());
    });
    const address = mockInference.address();
    if (!address || typeof address === "string") {
      throw new Error("mock inference server failed to bind");
    }
    process.env.INFERENCE_BASE_URL = `http://127.0.0.1:${address.port}`;
    process.env.INFERENCE_MODEL_ALIAS = "qwen3-8b";
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      mockInference.close((error) => (error ? reject(error) : resolve()));
    });
    if (previousBaseUrl === undefined) {
      delete process.env.INFERENCE_BASE_URL;
    } else {
      process.env.INFERENCE_BASE_URL = previousBaseUrl;
    }
    if (previousAlias === undefined) {
      delete process.env.INFERENCE_MODEL_ALIAS;
    } else {
      process.env.INFERENCE_MODEL_ALIAS = previousAlias;
    }
  });

  it("creates a legacy manual department conversation through the API", async () => {
    await seed(testDb());
    const app = await createTestApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/department-conversations",
      headers: auth(SCIENCE),
      payload: {
        recipientDepartmentId: MATH_DEPARTMENT,
        topic: "Manual arithmetic check",
        kind: "question",
        instruction: "What is 2 + 2?",
        idempotencyKey: "c171-api-manual-0001",
      },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json() as { turn: { conversationId: string; departmentId: string; body: string; id: string } };
    expect(body.turn.conversationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.turn.departmentId).toBe(SCIENCE_DEPARTMENT);
    expect(body.turn.body).toContain("Opening turn");

    const replay = await app.inject({
      method: "POST",
      url: "/api/v1/department-conversations",
      headers: auth(SCIENCE),
      payload: {
        recipientDepartmentId: MATH_DEPARTMENT,
        topic: "Manual arithmetic check",
        kind: "question",
        instruction: "What is 2 + 2?",
        idempotencyKey: "c171-api-manual-0001",
      },
    });
    expect(replay.statusCode).toBe(201);
    expect((replay.json() as { turn: { id: string } }).turn.id).toBe(body.turn.id);
    await app.close();
  });

  it("routes and opens a hybrid conversation through the API", async () => {
    await seed(testDb());
    const app = await createTestApp();
    const routed = await app.inject({
      method: "POST",
      url: "/api/v1/department-conversations/route",
      headers: auth(SCIENCE),
      payload: {
        task: "What's 2 + 2?",
        idempotencyKey: "c171-api-route-0001",
      },
    });
    expect(routed.statusCode).toBe(200);
    const routingBody = routed.json() as {
      routing: { method: string; primaryDepartmentId: string; decisionId: string };
    };
    expect(routingBody.routing.method).toBe("deterministic");
    expect(routingBody.routing.primaryDepartmentId).toBe(MATH_DEPARTMENT);

    const hybrid = await app.inject({
      method: "POST",
      url: "/api/v1/department-conversations",
      headers: auth(SCIENCE),
      payload: {
        routingMode: "hybrid",
        task: "What's 2 + 2?",
        kind: "question",
        instruction: "Ask Math for the exact answer.",
        idempotencyKey: "c171-api-hybrid-0001",
        routingIdempotencyKey: "c171-api-hybrid-route-0001",
      },
    });
    expect(hybrid.statusCode).toBe(201);
    const opened = hybrid.json() as {
      turn: { conversationId: string; departmentId: string };
      routing: { method: string; primaryDepartmentId: string; decisionId: string };
    };
    expect(opened.routing.method).toBe("deterministic");
    expect(opened.routing.primaryDepartmentId).toBe(MATH_DEPARTMENT);
    expect(opened.turn.departmentId).toBe(SCIENCE_DEPARTMENT);
    expect(opened.turn.conversationId).toMatch(/^[0-9a-f-]{36}$/);
    await app.close();
  });
});
