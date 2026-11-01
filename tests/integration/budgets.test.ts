import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  ADMIN_ID,
  auth,
  budget,
  createTestApp,
  departmentBody,
  parameterBudget,
  provisionDepartment,
} from "../helpers/app.js";

describe("budgets and audit", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
  });

  it("rejects an agent budget above the department and records budget changes", async () => {
    app = await createTestApp();
    const department = await provisionDepartment(
      app,
      departmentBody("budgeted", "specialized", budget({ cpu: 100, memory: 256, executions: 1 })),
    );
    const rejected = await app.inject({
      method: "POST",
      url: "/api/v1/agents",
      headers: auth(ADMIN_ID),
      payload: {
        departmentId: department.id,
        name: "Too expensive",
        role: "department_agent",
        description: "Exceeds the department CPU budget",
        computeBudget: budget({ cpu: 101, memory: 256, executions: 1 }),
        parameterBudget: parameterBudget(0),
      },
    });
    expect(rejected.statusCode).toBe(422);
    expect(rejected.json().error.code).toBe("BUDGET_EXCEEDED");

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/agents",
      headers: auth(ADMIN_ID),
      payload: {
        departmentId: department.id,
        name: "Within budget",
        role: "department_agent",
        description: "Fits the department budget",
        computeBudget: budget({ cpu: 50, memory: 128, executions: 1 }),
        parameterBudget: parameterBudget(0),
      },
    });
    expect(created.statusCode).toBe(201);
    const agentId = created.json().agent.id as string;

    const request = await app.inject({
      method: "POST",
      url: "/api/v1/approvals",
      headers: auth(ADMIN_ID),
      payload: {
        approvalType: "budget_change",
        targetType: "agent",
        targetId: agentId,
        computeBudget: budget({ cpu: 80, memory: 128, executions: 1 }),
        parameterBudget: parameterBudget(0),
      },
    });
    expect(request.statusCode).toBe(201);
    const decided = await app.inject({
      method: "POST",
      url: `/api/v1/approvals/${request.json().approval.id}/decide`,
      headers: auth(ADMIN_ID),
      payload: { decision: "approved", reason: "Raise the agent ceiling" },
    });
    expect(decided.statusCode).toBe(200);
    expect(decided.json().agent.computeBudget.maxCpuAllocation.value).toBe(80);

    const overDepartment = await app.inject({
      method: "POST",
      url: "/api/v1/approvals",
      headers: auth(ADMIN_ID),
      payload: {
        approvalType: "budget_change",
        targetType: "department",
        targetId: department.id,
        resourceBudget: budget({ cpu: 10, memory: 64, executions: 1 }),
      },
    });
    expect(overDepartment.statusCode).toBe(422);

    const audit = await app.inject({
      method: "GET",
      url: `/api/v1/audit-events?targetId=${agentId}&limit=50`,
      headers: auth(ADMIN_ID),
    });
    expect(audit.statusCode).toBe(200);
    expect(
      audit
        .json()
        .data.some((event: { eventType: string }) => event.eventType === "budget.changed"),
    ).toBe(true);
    expect(
      audit.json().data.some((event: { eventType: string }) => event.eventType === "agent.created"),
    ).toBe(true);
  });

  it("prevents an agent from approving its own budget", async () => {
    app = await createTestApp();
    const department = await provisionDepartment(
      app,
      departmentBody(
        "self-budget",
        "specialized",
        budget({ cpu: 500, memory: 1024, executions: 2 }),
      ),
    );
    const ceo = await app.inject({
      method: "POST",
      url: "/api/v1/agents",
      headers: auth(ADMIN_ID),
      payload: {
        departmentId: department.id,
        name: "Budget CEO",
        role: "ceo_agent",
        description: "Can approve other budgets but not its own",
        computeBudget: budget({ cpu: 100, memory: 256, executions: 1 }),
        parameterBudget: parameterBudget(0),
      },
    });
    const ceoPrincipal = ceo.json().agent.principalId as string;
    const agentId = ceo.json().agent.id as string;
    const request = await app.inject({
      method: "POST",
      url: "/api/v1/approvals",
      headers: auth(ADMIN_ID),
      payload: {
        approvalType: "budget_change",
        targetType: "agent",
        targetId: agentId,
        computeBudget: budget({ cpu: 200, memory: 256, executions: 1 }),
        parameterBudget: parameterBudget(0),
      },
    });
    expect(request.statusCode).toBe(201);
    const decision = await app.inject({
      method: "POST",
      url: `/api/v1/approvals/${request.json().approval.id}/decide`,
      headers: auth(ceoPrincipal),
      payload: { decision: "approved", reason: "Raise myself" },
    });
    expect(decision.statusCode).toBe(403);
    expect(decision.json().error.code).toBe("SELF_BUDGET_CHANGE_FORBIDDEN");
  });
});
