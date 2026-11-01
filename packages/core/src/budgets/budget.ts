import type { ParameterBudget, ResourceBudget } from "@ai-colony/contracts";
import { parameterBudgetSchema, resourceBudgetSchema } from "@ai-colony/contracts";
import { DomainError } from "../errors/domain-error.js";

const COMPARABLE_FIELDS = [
  "maxConcurrentExecutions",
  "maxCpuAllocation",
  "maxGpuAllocation",
  "maxMemoryAllocation",
  "maxEstimatedComputeExpenditure",
  "maxTrainingExpenditure",
  "maxModelParameterCount",
] as const;

type ComparableField = (typeof COMPARABLE_FIELDS)[number];

function numericValue(budget: ResourceBudget, field: ComparableField): number {
  const value = budget[field];
  return typeof value === "number" ? value : value.value;
}

export function parseResourceBudget(input: unknown): ResourceBudget {
  return resourceBudgetSchema.parse(input);
}

export function parseParameterBudget(input: unknown): ParameterBudget {
  return parameterBudgetSchema.parse(input);
}

export function assertParameterBudgetMatchesCompute(
  computeBudget: ResourceBudget,
  parameterBudget: ParameterBudget,
): void {
  if (parameterBudget.maxModelParameterCount.value !== computeBudget.maxModelParameterCount.value) {
    throw new DomainError(
      "BUDGET_INCONSISTENT",
      "Agent parameter budget must equal compute budget maxModelParameterCount",
      422,
      {
        parameterBudget: parameterBudget.maxModelParameterCount.value,
        computeBudget: computeBudget.maxModelParameterCount.value,
      },
    );
  }
}

export function assertAgentBudgetWithinDepartment(
  computeBudget: ResourceBudget,
  parameterBudget: ParameterBudget,
  departmentBudget: ResourceBudget,
): void {
  assertParameterBudgetMatchesCompute(computeBudget, parameterBudget);
  for (const field of COMPARABLE_FIELDS) {
    const agentValue = numericValue(computeBudget, field);
    const departmentValue = numericValue(departmentBudget, field);
    if (agentValue > departmentValue) {
      throw new DomainError(
        "BUDGET_EXCEEDED",
        `Agent ${field} exceeds the department budget`,
        422,
        { field, agent: agentValue, department: departmentValue },
      );
    }
  }
  if (
    departmentBudget.expiresAt &&
    computeBudget.expiresAt &&
    Date.parse(computeBudget.expiresAt) > Date.parse(departmentBudget.expiresAt)
  ) {
    throw new DomainError(
      "BUDGET_EXCEEDED",
      "Agent budget expiration is later than the department budget expiration",
      422,
    );
  }
}

export function assertDepartmentBudgetCoversAgents(
  departmentBudget: ResourceBudget,
  agents: ReadonlyArray<{ computeBudget: ResourceBudget; parameterBudget: ParameterBudget }>,
): void {
  for (const agent of agents) {
    assertAgentBudgetWithinDepartment(agent.computeBudget, agent.parameterBudget, departmentBudget);
  }
}

/**
 * Stored budgets are definitions used for authorization and validation.
 * They do not meter cloud spend, reserve GPUs, or call a billing API.
 */
export const BUDGET_ENFORCEMENT_SCOPE = "definition-and-validation-only" as const;
