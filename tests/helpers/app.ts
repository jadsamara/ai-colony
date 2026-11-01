import type { ResourceBudget } from "@ai-colony/contracts";
import { SYSTEM_ADMINISTRATOR_ID } from "@ai-colony/contracts";
import type { FastifyInstance, InjectOptions } from "fastify";
import { createPersistence } from "@ai-colony/database";
import { buildApp } from "../../apps/api/src/app.js";
import { loadConfig } from "../../apps/api/src/config.js";
import { testDb } from "./db.js";
import { TEST_DATABASE_URL } from "./env.js";

const persistence = createPersistence(testDb(), async () => undefined);

export function auth(principalId: string): { authorization: string } {
  return { authorization: `Bearer ${principalId}` };
}

export const ADMIN_ID = SYSTEM_ADMINISTRATOR_ID;

export function budget(
  input: {
    cpu?: number;
    gpu?: number;
    memory?: number;
    executions?: number;
    compute?: number;
    training?: number;
    parameters?: number;
  } = {},
): ResourceBudget {
  return {
    maxConcurrentExecutions: input.executions ?? 2,
    maxCpuAllocation: { value: input.cpu ?? 1000, unit: "millicores" },
    maxGpuAllocation: { value: input.gpu ?? 0, unit: "devices" },
    maxMemoryAllocation: { value: input.memory ?? 2048, unit: "mebibytes" },
    maxEstimatedComputeExpenditure: { value: input.compute ?? 0, unit: "usd_micros" },
    maxTrainingExpenditure: { value: input.training ?? 0, unit: "usd_micros" },
    maxModelParameterCount: { value: input.parameters ?? 0, unit: "parameters" },
    resetPeriod: null,
    expiresAt: null,
  };
}

export function parameterBudget(value: number) {
  return { maxModelParameterCount: { value, unit: "parameters" as const } };
}

export async function createTestApp(options?: {
  authMode?: "development" | "disabled";
  checkReady?: () => Promise<boolean>;
  staleAfterMs?: number;
}): Promise<FastifyInstance> {
  const config = loadConfig({
    NODE_ENV: "test",
    PORT: "3000",
    HOST: "127.0.0.1",
    DATABASE_URL: TEST_DATABASE_URL,
    AUTH_MODE: options?.authMode ?? "development",
    LOG_LEVEL: "silent",
    RUNTIME_STALE_AFTER_MS: String(options?.staleAfterMs ?? 30_000),
  });
  return buildApp({
    config,
    persistence,
    ...(options?.checkReady ? { checkReady: options.checkReady } : {}),
  });
}

export async function provisionDepartment(
  app: FastifyInstance,
  body: ReturnType<typeof departmentBody>,
  actorId = ADMIN_ID,
): Promise<{ id: string; status: string }> {
  const created = await expectStatus(
    app,
    {
      method: "POST",
      url: "/api/v1/departments",
      headers: auth(actorId),
      payload: body,
    },
    201,
  );
  const departmentId = created.department.id as string;
  const creation = await expectStatus(
    app,
    {
      method: "POST",
      url: "/api/v1/approvals",
      headers: auth(actorId),
      payload: { approvalType: "department_create", targetId: departmentId },
    },
    201,
  );
  await expectStatus(
    app,
    {
      method: "POST",
      url: `/api/v1/approvals/${creation.approval.id}/decide`,
      headers: auth(ADMIN_ID),
      payload: { decision: "approved", reason: "Provision for test" },
    },
    200,
  );
  const activation = await expectStatus(
    app,
    {
      method: "POST",
      url: "/api/v1/approvals",
      headers: auth(actorId),
      payload: { approvalType: "department_activate", targetId: departmentId },
    },
    201,
  );
  const decided = await expectStatus(
    app,
    {
      method: "POST",
      url: `/api/v1/approvals/${activation.approval.id}/decide`,
      headers: auth(ADMIN_ID),
      payload: { decision: "approved", reason: "Activate for test" },
    },
    200,
  );
  return decided.department as { id: string; status: string };
}

async function expectStatus(app: FastifyInstance, options: InjectOptions, statusCode: number) {
  const response = await app.inject(options);
  if (response.statusCode !== statusCode) {
    throw new Error(
      `${options.method} ${options.url} returned ${response.statusCode}: ${response.body}`,
    );
  }
  return response.json() as {
    department: { id: string; status: string };
    approval: { id: string };
  };
}

export function departmentBody(
  suffix: string,
  type: "system" | "specialized" | "temporary" | "experimental" = "specialized",
  resourceBudget = budget(),
) {
  return {
    name: `Department ${suffix}`,
    slug: `department-${suffix}`,
    description: `Description ${suffix}`,
    purpose: `Purpose ${suffix}`,
    departmentType: type,
    resourceBudget,
    metadata: {},
  };
}
