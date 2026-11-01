import { randomUUID } from "node:crypto";
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

describe("governance", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
  });

  it("requires approval before a new department becomes active and resumes a pause without a second approval", async () => {
    app = await createTestApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/departments",
      headers: auth(ADMIN_ID),
      payload: departmentBody("governed"),
    });
    const departmentId = created.json().department.id as string;
    const premature = await app.inject({
      method: "POST",
      url: `/api/v1/departments/${departmentId}/activate`,
      headers: auth(ADMIN_ID),
    });
    expect(premature.statusCode).toBe(409);

    const creation = await app.inject({
      method: "POST",
      url: "/api/v1/approvals",
      headers: auth(ADMIN_ID),
      payload: { approvalType: "department_create", targetId: departmentId },
    });
    const provisioned = await app.inject({
      method: "POST",
      url: `/api/v1/approvals/${creation.json().approval.id}/decide`,
      headers: auth(ADMIN_ID),
      payload: { decision: "approved", reason: "Creation is sound" },
    });
    expect(provisioned.json().department.status).toBe("provisioning");

    const stillBlocked = await app.inject({
      method: "POST",
      url: `/api/v1/departments/${departmentId}/activate`,
      headers: auth(ADMIN_ID),
    });
    expect(stillBlocked.statusCode).toBe(409);
    expect(stillBlocked.json().error.code).toBe("APPROVAL_REQUIRED");

    const activation = await app.inject({
      method: "POST",
      url: "/api/v1/approvals",
      headers: auth(ADMIN_ID),
      payload: { approvalType: "department_activate", targetId: departmentId },
    });
    const active = await app.inject({
      method: "POST",
      url: `/api/v1/approvals/${activation.json().approval.id}/decide`,
      headers: auth(ADMIN_ID),
      payload: { decision: "approved", reason: "Ready" },
    });
    expect(active.json().department.status).toBe("active");

    const paused = await app.inject({
      method: "POST",
      url: `/api/v1/departments/${departmentId}/pause`,
      headers: auth(ADMIN_ID),
    });
    expect(paused.json().department.status).toBe("paused");
    const resumed = await app.inject({
      method: "POST",
      url: `/api/v1/departments/${departmentId}/activate`,
      headers: auth(ADMIN_ID),
    });
    expect(resumed.json().department.status).toBe("active");
  });

  it("lets a CEO approve a temporary department and blocks permanent approval and self-approval", async () => {
    app = await createTestApp();
    const home = await provisionDepartment(app, departmentBody("ceo-home", "system"));
    const ceo = await app.inject({
      method: "POST",
      url: "/api/v1/agents",
      headers: auth(ADMIN_ID),
      payload: {
        departmentId: home.id,
        name: "Chief Executive",
        role: "ceo_agent",
        description: "CEO principal used for governance tests",
        computeBudget: budget({ cpu: 100, memory: 256, executions: 1 }),
        parameterBudget: parameterBudget(0),
      },
    });
    expect(ceo.statusCode).toBe(201);
    const ceoId = ceo.json().agent.principalId as string;

    const temporary = await app.inject({
      method: "POST",
      url: "/api/v1/departments",
      headers: auth(ceoId),
      payload: departmentBody("pop-up", "temporary"),
    });
    expect(temporary.statusCode).toBe(201);
    const temporaryId = temporary.json().department.id as string;
    const ownRequest = await app.inject({
      method: "POST",
      url: "/api/v1/approvals",
      headers: auth(ceoId),
      payload: { approvalType: "department_create", targetId: temporaryId },
    });
    const selfDecision = await app.inject({
      method: "POST",
      url: `/api/v1/approvals/${ownRequest.json().approval.id}/decide`,
      headers: auth(ceoId),
      payload: { decision: "approved", reason: "I requested this" },
    });
    expect(selfDecision.statusCode).toBe(403);
    expect(selfDecision.json().error.code).toBe("SELF_APPROVAL_FORBIDDEN");

    const observerId = randomUUID();
    await testDb().insert(schema.principals).values({
      id: observerId,
      principalType: "human",
      displayName: "Observer",
      roleName: "read_only_observer",
      agentId: null,
    });
    const denied = await app.inject({
      method: "POST",
      url: "/api/v1/departments",
      headers: auth(observerId),
      payload: departmentBody("observer-denied", "temporary"),
    });
    expect(denied.statusCode).toBe(403);

    const approved = await app.inject({
      method: "POST",
      url: `/api/v1/approvals/${ownRequest.json().approval.id}/decide`,
      headers: auth(ADMIN_ID),
      payload: { decision: "approved", reason: "External administrator" },
    });
    expect(approved.statusCode).toBe(200);

    const permanent = await app.inject({
      method: "POST",
      url: "/api/v1/departments",
      headers: auth(ADMIN_ID),
      payload: departmentBody("permanent", "specialized"),
    });
    const permanentRequest = await app.inject({
      method: "POST",
      url: "/api/v1/approvals",
      headers: auth(ADMIN_ID),
      payload: { approvalType: "department_create", targetId: permanent.json().department.id },
    });
    const ceoPermanent = await app.inject({
      method: "POST",
      url: `/api/v1/approvals/${permanentRequest.json().approval.id}/decide`,
      headers: auth(ceoId),
      payload: { decision: "approved", reason: "CEO tries permanent" },
    });
    expect(ceoPermanent.statusCode).toBe(403);
    expect(ceoPermanent.json().error.code).toBe("PERMANENT_APPROVAL_FORBIDDEN");

    const systemAttempt = await app.inject({
      method: "POST",
      url: "/api/v1/departments",
      headers: auth(ceoId),
      payload: departmentBody("fake-system", "system"),
    });
    expect(systemAttempt.statusCode).toBe(403);

    const escalated = await app.inject({
      method: "POST",
      url: "/api/v1/agents",
      headers: auth(ceoId),
      payload: {
        departmentId: home.id,
        name: "Second CEO",
        role: "ceo_agent",
        description: "Should be rejected",
        computeBudget: budget({ cpu: 10, memory: 128, executions: 1 }),
        parameterBudget: parameterBudget(0),
      },
    });
    expect(escalated.statusCode).toBe(403);
    expect(escalated.json().error.code).toBe("PRIVILEGE_ESCALATION");

    const worker = await app.inject({
      method: "POST",
      url: "/api/v1/agents",
      headers: auth(ADMIN_ID),
      payload: {
        departmentId: home.id,
        name: "Worker",
        role: "department_agent",
        description: "Ordinary agent",
        computeBudget: budget({ cpu: 10, memory: 128, executions: 1 }),
        parameterBudget: parameterBudget(0),
      },
    });
    const selfRole = await app.inject({
      method: "POST",
      url: `/api/v1/agents/${worker.json().agent.id}/role`,
      headers: auth(worker.json().agent.principalId),
      payload: { role: "monitoring_agent" },
    });
    expect(selfRole.statusCode).toBe(403);

    const adminRole = await app.inject({
      method: "POST",
      url: `/api/v1/agents/${worker.json().agent.id}/role`,
      headers: auth(ADMIN_ID),
      payload: { role: "system_administrator" },
    });
    expect(adminRole.statusCode).toBe(403);
    expect(adminRole.json().error.code).toBe("PRIVILEGE_ESCALATION");
  });
});
