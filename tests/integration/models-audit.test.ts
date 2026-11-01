import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { schema, seed } from "@ai-colony/database";
import { listRoleGrants } from "@ai-colony/core";
import { ADMIN_ID, auth, createTestApp } from "../helpers/app.js";
import { testDb } from "../helpers/db.js";

function messageChain(error: unknown): string {
  const messages: string[] = [];
  let current = error;
  while (current instanceof Error && messages.length < 6) {
    messages.push(current.message);
    current = current.cause;
  }
  return messages.join(" ");
}

describe("models, audit immutability, and seed", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) {
      await app.close();
    }
  });

  it("registers model metadata, keeps history, and does not deploy artifacts", async () => {
    app = await createTestApp();
    const registered = await app.inject({
      method: "POST",
      url: "/api/v1/models",
      headers: auth(ADMIN_ID),
      payload: modelBody("Example 1B"),
    });
    expect(registered.statusCode).toBe(201);
    const first = registered.json().model;
    expect(first.artifactUri).toBeNull();
    expect(first.version).toBe(1);
    expect(first.status).toBe("registered");

    const second = await app.inject({
      method: "POST",
      url: `/api/v1/models/${first.id}/versions`,
      headers: auth(ADMIN_ID),
      payload: {
        ...modelBody("Example 1B"),
        parameterCount: 1_100_000_000,
        status: "not_deployed",
      },
    });
    expect(second.statusCode).toBe(201);
    expect(second.json().model.version).toBe(2);
    expect(second.json().model.lineageId).toBe(first.lineageId);
    expect(second.json().model.id).not.toBe(first.id);

    const original = await app.inject({
      method: "GET",
      url: `/api/v1/models/${first.id}`,
      headers: auth(ADMIN_ID),
    });
    expect(original.json().model.parameterCount).toBe(1_000_000_000);
    expect(original.json().model.status).toBe("registered");

    const listed = await app.inject({
      method: "GET",
      url: `/api/v1/models?lineageId=${first.lineageId}`,
      headers: auth(ADMIN_ID),
    });
    expect(listed.json().data).toHaveLength(2);
  });

  it("seeds departments and models idempotently without resetting later state", async () => {
    const first = await seed(testDb());
    const second = await seed(testDb());
    expect(first.departmentsInserted).toBe(12);
    expect(first.modelsInserted).toBe(3);
    expect(second.departmentsInserted).toBe(0);
    expect(second.modelsInserted).toBe(0);

    const departments = await testDb().select().from(schema.departments);
    const models = await testDb().select().from(schema.models);
    expect(departments).toHaveLength(12);
    expect(models).toHaveLength(3);
    expect(
      models.every((model) => model.artifactUri === null && model.status === "not_deployed"),
    ).toBe(true);

    const grants = await testDb().select().from(schema.rolePermissions);
    expect(grants).toHaveLength(listRoleGrants().length);

    app = await createTestApp();
    const ceo = departments.find((department) => department.slug === "ceo");
    expect(ceo).toBeDefined();
    const paused = await app.inject({
      method: "POST",
      url: `/api/v1/departments/${ceo?.id}/pause`,
      headers: auth(ADMIN_ID),
    });
    expect(paused.statusCode).toBe(200);
    const qwen = models.find((model) => model.displayName === "Qwen3-8B");
    const deprecated = await app.inject({
      method: "PATCH",
      url: `/api/v1/models/${qwen?.id}/status`,
      headers: auth(ADMIN_ID),
      payload: { status: "deprecated" },
    });
    expect(deprecated.statusCode).toBe(200);
    await seed(testDb());
    const [ceoAfter] = await testDb()
      .select()
      .from(schema.departments)
      .where(eq(schema.departments.slug, "ceo"));
    const [qwenAfter] = await testDb()
      .select()
      .from(schema.models)
      .where(eq(schema.models.id, qwen?.id ?? "00000000-0000-4000-8000-000000000101"));
    expect(ceoAfter?.status).toBe("paused");
    expect(qwenAfter?.status).toBe("deprecated");
    expect(qwenAfter?.parameterCount).toBe(8_200_000_000);
  });

  it("rejects updates and deletes of audit events and has no delete route", async () => {
    app = await createTestApp();
    await app.inject({
      method: "POST",
      url: "/api/v1/departments",
      headers: auth(ADMIN_ID),
      payload: {
        name: "Audit Target",
        slug: "audit-target",
        description: "Creates an audit row",
        purpose: "Audit immutability",
        departmentType: "experimental",
        resourceBudget: {
          maxConcurrentExecutions: 1,
          maxCpuAllocation: { value: 100, unit: "millicores" },
          maxGpuAllocation: { value: 0, unit: "devices" },
          maxMemoryAllocation: { value: 128, unit: "mebibytes" },
          maxEstimatedComputeExpenditure: { value: 0, unit: "usd_micros" },
          maxTrainingExpenditure: { value: 0, unit: "usd_micros" },
          maxModelParameterCount: { value: 0, unit: "parameters" },
          resetPeriod: null,
          expiresAt: null,
        },
      },
    });
    await expect(
      testDb().execute(sql`update audit_events set action = 'tamper'`),
    ).rejects.toSatisfy((error: unknown) => /append-only/.test(messageChain(error)));
    await expect(testDb().execute(sql`delete from audit_events`)).rejects.toSatisfy(
      (error: unknown) => /append-only/.test(messageChain(error)),
    );
    const missing = await app.inject({
      method: "DELETE",
      url: "/api/v1/audit-events/00000000-0000-4000-8000-000000000099",
      headers: auth(ADMIN_ID),
    });
    expect(missing.statusCode).toBe(404);
  });
});

function modelBody(displayName: string) {
  return {
    displayName,
    modelFamily: "example",
    provider: "registry-metadata",
    parameterCount: 1_000_000_000,
    modelType: "causal-lm",
    artifactUri: null,
    deploymentTarget: "none",
    status: "registered",
    quantization: null,
    contextWindow: 4096,
    capabilities: ["text-generation"],
    trainable: false,
  };
}
