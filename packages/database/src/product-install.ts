import { randomUUID } from "node:crypto";
import { SPECIFICATION_VERSION, SYSTEM_ADMINISTRATOR_ID, type AgentStatus, type DepartmentStatus } from "@ai-colony/contracts";
import {
  EVALUATION_DEPARTMENT_ID,
  GAMING_AGENT_ID,
  GAMING_DEPARTMENT_ID,
  GAMING_ENDPOINT_REFERENCE,
  GAMING_SERVING_INSTANCE_ID,
  PRODUCT_AGENT_ID,
  PRODUCT_DEPARTMENT_ID,
  PRODUCT_ENDPOINT_REFERENCE,
  PRODUCT_MODEL_VERSION,
  PRODUCT_SERVING_INSTANCE_ID,
  SHARED_QWEN3_8B_MODEL_ID,
  assertAgentTransition,
  assertCanDecideApproval,
  assertDepartmentTransition,
  snapshot,
} from "@ai-colony/core";
import { eq } from "drizzle-orm";
import type { DbExecutor } from "./client.js";
import {
  agentLifecycleEvents,
  agents,
  approvalRequests,
  auditEvents,
  departmentServingEvents,
  departmentServingInstances,
  departments,
  principals,
} from "./schema/index.js";

const ADMINISTRATOR = {
  principalId: SYSTEM_ADMINISTRATOR_ID,
  principalType: "system" as const,
  role: "system_administrator" as const,
  agentId: null,
  departmentId: null,
  permissions: [] as string[],
};

export interface ProductInstallResult {
  departmentsInserted: number;
  agentsInserted: number;
  gamingStatus: string;
  productStatus: string;
  productDepartmentId: string;
  productAgentId: string;
  productInstanceId: string;
  productEndpoint: string;
  gamingEndpoint: string;
  gamingInstanceStatus: string;
  engineeringStatus: string | null;
  activeDepartments: number;
  evaluationDepartmentId: string;
}

export async function installProductDepartment(db: DbExecutor): Promise<ProductInstallResult> {
  const departmentRows = await db.select().from(departments);
  const engineering = departmentRows.find((row) => row.slug === "engineering") ?? null;
  const engineeringStatus = engineering?.status ?? null;
  const gaming = departmentRows.find((row) => row.slug === "gaming");
  if (!gaming) {
    throw new Error("Gaming department is missing. Retirement requires the historical record.");
  }
  if (gaming.id !== GAMING_DEPARTMENT_ID) {
    throw new Error("Refusing to retire a Gaming row that does not use the historical department id.");
  }
  if (gaming.status !== "archived") {
    const children = departmentRows.filter(
      (row) => row.parentDepartmentId === gaming.id && row.status !== "archived",
    );
    if (children.length > 0) {
      throw new Error("Gaming has non-archived child departments and cannot be archived.");
    }
    assertDepartmentTransition(gaming.status as DepartmentStatus, "archived");
    await db
      .update(departments)
      .set({ status: "archived", updatedAt: new Date() })
      .where(eq(departments.id, gaming.id));
    await recordAudit(db, "department.archived", "archive", gaming.id, snapshot({ status: gaming.status }), snapshot({
      id: gaming.id,
      slug: gaming.slug,
      status: "archived",
    }), { reason: "Gaming is retired from the active inventory. Historical records are retained." });
  }

  const agentRows = await db.select().from(agents);
  const gamingAgent = agentRows.find((row) => row.id === GAMING_AGENT_ID);
  if (!gamingAgent || gamingAgent.departmentId !== GAMING_DEPARTMENT_ID) {
    throw new Error("Gaming agent history is missing or is not attached to the Gaming department.");
  }
  if (gamingAgent.status !== "archived") {
    assertAgentTransition(gamingAgent.status as AgentStatus, "archived");
    await db
      .update(agents)
      .set({ status: "archived", updatedAt: new Date() })
      .where(eq(agents.id, gamingAgent.id));
    await db.insert(agentLifecycleEvents).values({
      agentId: gamingAgent.id,
      fromStatus: gamingAgent.status,
      toStatus: "archived",
      reason: "The Gaming agent is retired with its department and cannot accept new tasks.",
      actorId: SYSTEM_ADMINISTRATOR_ID,
      actorType: "system",
      correlationId: "m12.2-product",
    });
    await recordAudit(db, "agent.archived", "archive", gamingAgent.id, snapshot({ status: gamingAgent.status }), snapshot({
      id: gamingAgent.id,
      status: "archived",
    }), {});
  }

  const instances = await db.select().from(departmentServingInstances);
  let gamingInstance = instances.find((row) => row.departmentId === GAMING_DEPARTMENT_ID);
  if (!gamingInstance) {
    await db.insert(departmentServingInstances).values({
      id: GAMING_SERVING_INSTANCE_ID,
      departmentId: GAMING_DEPARTMENT_ID,
      agentId: GAMING_AGENT_ID,
      provider: "ollama",
      endpointReference: GAMING_ENDPOINT_REFERENCE,
      normalizedEndpoint: GAMING_ENDPOINT_REFERENCE,
      modelRegistryId: SHARED_QWEN3_8B_MODEL_ID,
      modelVersion: PRODUCT_MODEL_VERSION,
      artifactDigest: null,
      deploymentMode: "dedicated",
      status: "stopped",
      resourcePolicyId: "policy:gaming",
    });
    await db.insert(departmentServingEvents).values({
      id: randomUUID(),
      instanceId: GAMING_SERVING_INSTANCE_ID,
      fromStatus: "configured",
      toStatus: "stopped",
      actorId: SYSTEM_ADMINISTRATOR_ID,
      reason: "Gaming serving is retired. The model volume is not deleted.",
    });
    gamingInstance = { status: "stopped" } as typeof instances[number];
  } else if (gamingInstance.id !== GAMING_SERVING_INSTANCE_ID) {
    throw new Error("Gaming serving instance id does not match the historical instance.");
  } else if (gamingInstance.status !== "stopped") {
    await db
      .update(departmentServingInstances)
      .set({ status: "stopped", updatedAt: new Date() })
      .where(eq(departmentServingInstances.id, gamingInstance.id));
    await db.insert(departmentServingEvents).values({
      id: randomUUID(),
      instanceId: gamingInstance.id,
      fromStatus: gamingInstance.status,
      toStatus: "stopped",
      actorId: SYSTEM_ADMINISTRATOR_ID,
      reason: "Gaming serving is retired. The model volume is not deleted.",
    });
  }

  const ceo = departmentRows.find((row) => row.slug === "ceo");
  if (!ceo) {
    throw new Error("CEO department is required before Product can be created.");
  }
  let departmentsInserted = 0;
  let product = departmentRows.find((row) => row.slug === "product" || row.id === PRODUCT_DEPARTMENT_ID) ?? null;
  if (product && product.id !== PRODUCT_DEPARTMENT_ID) {
    throw new Error("A Product department exists with an unexpected id.");
  }
  if (!product) {
    const inserted = await db
      .insert(departments)
      .values({
        id: PRODUCT_DEPARTMENT_ID,
        name: "Product",
        slug: "product",
        description: "Continuous improvement of the colony as a system.",
        purpose: "Identify gaps, propose measured improvements, and track outcomes. Cannot approve its own proposals or create departments.",
        parentDepartmentId: null,
        status: "proposed",
        departmentType: "system",
        creationSource: "api",
        createdBy: SYSTEM_ADMINISTRATOR_ID,
        resourceBudget: ceo.resourceBudget,
        policyRef: "rbac:m12.2-product",
        metadata: { milestone: "m12.2", permanent: true },
        specificationVersion: SPECIFICATION_VERSION,
      })
      .returning();
    product = inserted[0] ?? null;
    if (!product) {
      throw new Error("Product department insert did not return a row.");
    }
    departmentsInserted += 1;
    await recordAudit(db, "department.created", "create", product.id, null, snapshot({
      id: product.id,
      slug: product.slug,
      status: "proposed",
      departmentType: "system",
      creationSource: "api",
    }), { milestone: "m12.2" });
  }

  if (product.status === "proposed") {
    const approvalId = await decidePermanent(db, "department_create", product.id, "Administrator authorizes provisioning of the permanent Product department.");
    assertDepartmentTransition("proposed", "provisioning");
    await db.update(departments).set({ status: "provisioning", updatedAt: new Date() }).where(eq(departments.id, product.id));
    await recordAudit(db, "department.provisioned", "provision", product.id, snapshot({ status: "proposed" }), snapshot({
      status: "provisioning",
    }), { approvalId });
    product = { ...product, status: "provisioning" };
  }
  if (product.status === "provisioning") {
    const approvalId = await decidePermanent(db, "department_activate", product.id, "Administrator activates the permanent Product department. Product cannot approve its own work.");
    assertDepartmentTransition("provisioning", "active");
    await db.update(departments).set({ status: "active", updatedAt: new Date() }).where(eq(departments.id, product.id));
    await recordAudit(db, "department.activated", "activate", product.id, snapshot({ status: "provisioning" }), snapshot({
      status: "active",
    }), { approvalId });
    product = { ...product, status: "active" };
  }
  if (product.status !== "active") {
    throw new Error(`Product department is ${product.status} and cannot be activated by this installer.`);
  }

  let agentsInserted = 0;
  const refreshedAgents = await db.select().from(agents);
  const productAgent = refreshedAgents.find((row) => row.id === PRODUCT_AGENT_ID);
  if (productAgent && productAgent.departmentId !== PRODUCT_DEPARTMENT_ID) {
    throw new Error("Product agent id is already used by another department.");
  }
  if (!productAgent) {
    await db.insert(agents).values({
      id: PRODUCT_AGENT_ID,
      departmentId: PRODUCT_DEPARTMENT_ID,
      name: "Product",
      roleName: "department_agent",
      description: "Proposes colony improvements. Cannot approve them, create a department, promote weights, or deploy infrastructure.",
      capabilities: ["text-generation"],
      modelId: SHARED_QWEN3_8B_MODEL_ID,
      adapterVersion: null,
      memoryNamespace: "seed.product",
      computeBudget: { ...ceo.resourceBudget, maxConcurrentExecutions: 1 },
      parameterBudget: { maxModelParameterCount: { value: 0, unit: "parameters" } },
      status: "idle",
      performanceMetrics: {},
      parentAgentId: null,
      specificationVersion: SPECIFICATION_VERSION,
    });
    await db.insert(principals).values({
      id: PRODUCT_AGENT_ID,
      principalType: "agent",
      displayName: "Product",
      roleName: "department_agent",
      agentId: PRODUCT_AGENT_ID,
    }).onConflictDoNothing();
    await recordAudit(db, "agent.created", "create", PRODUCT_AGENT_ID, null, snapshot({
      id: PRODUCT_AGENT_ID,
      name: "Product",
      role: "department_agent",
      status: "idle",
    }), {});
    agentsInserted += 1;
  }

  const refreshedInstances = await db.select().from(departmentServingInstances);
  const productInstance = refreshedInstances.find((row) => row.departmentId === PRODUCT_DEPARTMENT_ID);
  if (productInstance && productInstance.id !== PRODUCT_SERVING_INSTANCE_ID) {
    throw new Error("Product serving instance id does not match the dedicated instance id.");
  }
  if (productInstance && productInstance.endpointReference !== PRODUCT_ENDPOINT_REFERENCE) {
    throw new Error("Product serving reference is not serving://product.");
  }
  if (!productInstance) {
    await db.insert(departmentServingInstances).values({
      id: PRODUCT_SERVING_INSTANCE_ID,
      departmentId: PRODUCT_DEPARTMENT_ID,
      agentId: PRODUCT_AGENT_ID,
      provider: "ollama",
      endpointReference: PRODUCT_ENDPOINT_REFERENCE,
      normalizedEndpoint: PRODUCT_ENDPOINT_REFERENCE,
      modelRegistryId: SHARED_QWEN3_8B_MODEL_ID,
      modelVersion: PRODUCT_MODEL_VERSION,
      artifactDigest: null,
      deploymentMode: "dedicated",
      status: "configured",
      resourcePolicyId: "policy:product",
    });
    await db.insert(departmentServingEvents).values({
      id: randomUUID(),
      instanceId: PRODUCT_SERVING_INSTANCE_ID,
      fromStatus: "configured",
      toStatus: "configured",
      actorId: SYSTEM_ADMINISTRATOR_ID,
      reason: "Record the Product serving instance. This does not start a model and does not mark it ready.",
    });
  }

  const after = await db.select().from(departments);
  const engineeringAfter = after.find((row) => row.slug === "engineering") ?? null;
  if ((engineeringAfter?.status ?? null) !== engineeringStatus) {
    throw new Error("Product installation changed the Engineering department.");
  }
  const activeDepartments = after.filter((row) => row.status === "active").length;
  const gamingAfter = after.find((row) => row.id === GAMING_DEPARTMENT_ID);
  const productAfter = after.find((row) => row.id === PRODUCT_DEPARTMENT_ID);
  const gamingServing = (await db.select().from(departmentServingInstances)).find(
    (row) => row.id === GAMING_SERVING_INSTANCE_ID,
  );
  return {
    departmentsInserted,
    agentsInserted,
    gamingStatus: gamingAfter?.status ?? "missing",
    productStatus: productAfter?.status ?? "missing",
    productDepartmentId: PRODUCT_DEPARTMENT_ID,
    productAgentId: PRODUCT_AGENT_ID,
    productInstanceId: PRODUCT_SERVING_INSTANCE_ID,
    productEndpoint: PRODUCT_ENDPOINT_REFERENCE,
    gamingEndpoint: GAMING_ENDPOINT_REFERENCE,
    gamingInstanceStatus: gamingServing?.status ?? "missing",
    engineeringStatus,
    activeDepartments,
    evaluationDepartmentId: EVALUATION_DEPARTMENT_ID,
  };
}

async function decidePermanent(
  db: DbExecutor,
  approvalType: "department_create" | "department_activate",
  targetId: string,
  reason: string,
): Promise<string> {
  assertCanDecideApproval(ADMINISTRATOR, { requestedBy: SYSTEM_ADMINISTRATOR_ID, approvalType }, "system");
  const id = randomUUID();
  const now = new Date();
  await db.insert(approvalRequests).values({
    id,
    approvalType,
    targetType: "department",
    targetId,
    payload: { approvalType, targetId },
    status: "approved",
    requestedBy: SYSTEM_ADMINISTRATOR_ID,
    decidedBy: SYSTEM_ADMINISTRATOR_ID,
    decisionReason: reason,
    decidedAt: now,
    consumedAt: now,
  });
  return id;
}

async function recordAudit(
  db: DbExecutor,
  eventType: string,
  action: string,
  targetId: string,
  beforeState: Record<string, unknown> | null,
  afterState: Record<string, unknown> | null,
  metadata: Record<string, unknown>,
): Promise<void> {
  await db.insert(auditEvents).values({
    eventId: randomUUID(),
    eventType,
    actorId: SYSTEM_ADMINISTRATOR_ID,
    actorType: "system",
    targetType: eventType.startsWith("agent.") ? "agent" : "department",
    targetId,
    action,
    correlationId: "m12.2-product",
    beforeState,
    afterState,
    metadata,
  });
}
