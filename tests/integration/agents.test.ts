import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { schema } from "@ai-colony/database";
import {
  ADMIN_ID,
  auth,
  budget,
  createTestApp,
  departmentBody,
  parameterBudget,
  provisionDepartment,
} from "../helpers/app.js";
import { testDb } from "../helpers/db.js";

describe("agents", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) {
      await app.close();
    }
  });

  it("registers an agent in an active department and rejects a proposed department", async () => {
    app = await createTestApp();
    const proposed = await app.inject({
      method: "POST",
      url: "/api/v1/departments",
      headers: auth(ADMIN_ID),
      payload: departmentBody("proposed-home"),
    });
    const tooEarly = await app.inject({
      method: "POST",
      url: "/api/v1/agents",
      headers: auth(ADMIN_ID),
      payload: agentPayload(proposed.json().department.id, "early"),
    });
    expect(tooEarly.statusCode).toBe(409);
    expect(tooEarly.json().error.code).toBe("DEPARTMENT_NOT_ACTIVE");

    const department = await provisionDepartment(app, departmentBody("home"));
    expect(department.status).toBe("active");
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/agents",
      headers: auth(ADMIN_ID),
      payload: agentPayload(department.id, "worker"),
    });
    expect(created.statusCode).toBe(201);
    const body = created.json();
    expect(body.agent.departmentId).toBe(department.id);
    expect(body.agent.status).toBe("registered");
    expect(body.runtime.localExecution.activelyExecuting).toBe(false);
    expect(body.runtime.localExecution.attached).toBe(false);

    const members = await app.inject({
      method: "GET",
      url: `/api/v1/departments/${department.id}/agents`,
      headers: auth(ADMIN_ID),
    });
    expect(members.json().data.map((agent: { id: string }) => agent.id)).toContain(body.agent.id);
  });

  it("validates lifecycle transitions and does not treat a database status as execution", async () => {
    app = await createTestApp();
    const department = await provisionDepartment(app, departmentBody("runtime"));
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/agents",
      headers: auth(ADMIN_ID),
      payload: agentPayload(department.id, "runner"),
    });
    const agentId = created.json().agent.id as string;

    const startedEarly = await app.inject({
      method: "POST",
      url: `/api/v1/agents/${agentId}/start`,
      headers: auth(ADMIN_ID),
    });
    expect(startedEarly.statusCode).toBe(409);
    expect(startedEarly.json().error.code).toBe("INVALID_TRANSITION");

    const initialized = await app.inject({
      method: "POST",
      url: `/api/v1/agents/${agentId}/initialize`,
      headers: auth(ADMIN_ID),
    });
    expect(initialized.statusCode).toBe(200);
    expect(initialized.json().runtime.status).toBe("idle");
    expect(initialized.json().runtime.localExecution.activelyExecuting).toBe(false);

    const withoutExecutor = await app.inject({
      method: "POST",
      url: `/api/v1/agents/${agentId}/start`,
      headers: auth(ADMIN_ID),
    });
    expect(withoutExecutor.statusCode).toBe(409);
    expect(withoutExecutor.json().error.code).toBe("EXECUTOR_NOT_ATTACHED");

    const attached = await app.inject({
      method: "POST",
      url: `/api/v1/agents/${agentId}/executor`,
      headers: auth(ADMIN_ID),
      payload: { kind: "lifecycle-only" },
    });
    expect(attached.statusCode).toBe(200);
    expect(attached.json().runtime.localExecution.executor.inference).toBe(false);
    expect(attached.json().runtime.localExecution.executor.learning).toBe(false);
    expect(attached.json().runtime.localExecution.activelyExecuting).toBe(false);

    const running = await app.inject({
      method: "POST",
      url: `/api/v1/agents/${agentId}/start`,
      headers: auth(ADMIN_ID),
    });
    expect(running.statusCode).toBe(200);
    expect(running.json().runtime.status).toBe("running");
    expect(running.json().runtime.localExecution.activelyExecuting).toBe(true);

    const invalidPause = await app.inject({
      method: "POST",
      url: `/api/v1/agents/${agentId}/pause`,
      headers: auth(ADMIN_ID),
    });
    expect(invalidPause.statusCode).toBe(409);
    expect(invalidPause.json().error.code).toBe("INVALID_TRANSITION");

    const yielded = await app.inject({
      method: "POST",
      url: `/api/v1/agents/${agentId}/yield`,
      headers: auth(ADMIN_ID),
    });
    expect(yielded.json().runtime.status).toBe("idle");
    expect(yielded.json().runtime.localExecution.activelyExecuting).toBe(false);
    expect(yielded.json().runtime.localExecution.attached).toBe(true);

    await app.inject({
      method: "POST",
      url: `/api/v1/agents/${agentId}/start`,
      headers: auth(ADMIN_ID),
    });
    const stopped = await app.inject({
      method: "POST",
      url: `/api/v1/agents/${agentId}/stop`,
      headers: auth(ADMIN_ID),
    });
    expect(stopped.json().runtime.status).toBe("stopped");
    expect(stopped.json().runtime.localExecution.activelyExecuting).toBe(false);

    const events = await app.inject({
      method: "GET",
      url: `/api/v1/agents/${agentId}/lifecycle-events`,
      headers: auth(ADMIN_ID),
    });
    expect(events.json().data.length).toBeGreaterThan(0);
  });

  it("keeps an agent after the process restarts and recovers a stale running status", async () => {
    app = await createTestApp();
    const department = await provisionDepartment(app, departmentBody("persist"));
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/agents",
      headers: auth(ADMIN_ID),
      payload: agentPayload(department.id, "durable"),
    });
    const agentId = created.json().agent.id as string;
    await app.inject({
      method: "POST",
      url: `/api/v1/agents/${agentId}/initialize`,
      headers: auth(ADMIN_ID),
    });
    await app.close();

    const restarted = await createTestApp();
    const fetched = await restarted.inject({
      method: "GET",
      url: `/api/v1/agents/${agentId}`,
      headers: auth(ADMIN_ID),
    });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json().agent.status).toBe("idle");
    expect(fetched.json().runtime.localExecution.attached).toBe(false);
    expect(fetched.json().runtime.localExecution.activelyExecuting).toBe(false);
    await restarted.close();

    await testDb()
      .update(schema.agents)
      .set({
        status: "running",
        runtimeOwner: "dead-process",
        runtimeHeartbeatAt: new Date("2000-01-01T00:00:00.000Z"),
      })
      .where(eq(schema.agents.id, agentId));

    app = await createTestApp();
    const recovered = await app.inject({
      method: "GET",
      url: `/api/v1/agents/${agentId}/status`,
      headers: auth(ADMIN_ID),
    });
    expect(recovered.json().runtime.status).toBe("idle");
    expect(recovered.json().runtime.localExecution.activelyExecuting).toBe(false);
  });

  it("does not reconcile a fresh heartbeat owned by another process into local execution", async () => {
    app = await createTestApp();
    const department = await provisionDepartment(app, departmentBody("shared"));
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/agents",
      headers: auth(ADMIN_ID),
      payload: agentPayload(department.id, "remote"),
    });
    const agentId = created.json().agent.id as string;
    await testDb()
      .update(schema.agents)
      .set({
        status: "running",
        runtimeOwner: "other-process",
        runtimeHeartbeatAt: new Date(),
      })
      .where(eq(schema.agents.id, agentId));
    await app.close();

    app = await createTestApp();
    const status = await app.inject({
      method: "GET",
      url: `/api/v1/agents/${agentId}/status`,
      headers: auth(ADMIN_ID),
    });
    expect(status.json().runtime.status).toBe("running");
    expect(status.json().runtime.localExecution.activelyExecuting).toBe(false);
    expect(status.json().runtime.ownedByThisProcess).toBe(false);
  });
});

function agentPayload(departmentId: string, name: string) {
  return {
    departmentId,
    name,
    role: "department_agent",
    description: `${name} description`,
    capabilities: ["lifecycle"],
    computeBudget: budget({ cpu: 100, memory: 256, executions: 1 }),
    parameterBudget: parameterBudget(0),
  };
}
