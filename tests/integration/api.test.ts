import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { ADMIN_ID, auth, createTestApp } from "../helpers/app.js";

describe("api validation and operations", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
  });

  it("serves health without authentication and rejects anonymous API calls", async () => {
    app = await createTestApp();
    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ status: "ok", service: "ai-colony-api" });
    const ready = await app.inject({ method: "GET", url: "/api/v1/ready" });
    expect(ready.statusCode).toBe(200);
    expect(ready.json().checks.database).toBe("ok");

    const anonymous = await app.inject({ method: "GET", url: "/api/v1/departments" });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json().error.code).toBe("UNAUTHENTICATED");
  });

  it("returns structured validation errors and OpenAPI", async () => {
    app = await createTestApp();
    const invalid = await app.inject({
      method: "POST",
      url: "/api/v1/departments",
      headers: auth(ADMIN_ID),
      payload: { name: "" },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe("VALIDATION_ERROR");

    const sneaky = await app.inject({
      method: "PATCH",
      url: "/api/v1/departments/00000000-0000-4000-8000-000000000011",
      headers: auth(ADMIN_ID),
      payload: { status: "active" },
    });
    expect(sneaky.statusCode).toBe(400);

    const spec = await app.inject({ method: "GET", url: "/api/v1/openapi.json" });
    expect(spec.statusCode).toBe(200);
    const document = spec.json() as { openapi: string; paths: Record<string, unknown> };
    expect(document.openapi).toMatch(/^3\./);
    expect(document.paths["/api/v1/departments"]).toBeDefined();
    expect(document.paths["/api/v1/agents"]).toBeDefined();
    expect(document.paths["/api/v1/models"]).toBeDefined();
    expect(document.paths["/api/v1/approvals"]).toBeDefined();
    expect(document.paths["/api/v1/audit-events"]).toBeDefined();
  });

  it("reports readiness failure without taking the process down", async () => {
    app = await createTestApp({ checkReady: async () => false });
    const ready = await app.inject({ method: "GET", url: "/ready" });
    expect(ready.statusCode).toBe(503);
    expect(ready.json().checks.database).toBe("down");
  });

  it("does not honor development bearer tokens when auth is disabled", async () => {
    app = await createTestApp({ authMode: "disabled" });
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/departments",
      headers: auth(ADMIN_ID),
    });
    expect(response.statusCode).toBe(401);
    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
  });
});
