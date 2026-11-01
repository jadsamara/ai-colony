import { describe, expect, it } from "vitest";
import { resourceBudgetSchema, type ResourceBudget } from "@ai-colony/contracts";
import {
  assertAgentBudgetWithinDepartment,
  assertParameterBudgetMatchesCompute,
  BUDGET_ENFORCEMENT_SCOPE,
  DomainError,
} from "@ai-colony/core";

function budget(cpu: number, parameters = 0): ResourceBudget {
  return {
    maxConcurrentExecutions: 2,
    maxCpuAllocation: { value: cpu, unit: "millicores" },
    maxGpuAllocation: { value: 0, unit: "devices" },
    maxMemoryAllocation: { value: 512, unit: "mebibytes" },
    maxEstimatedComputeExpenditure: { value: 0, unit: "usd_micros" },
    maxTrainingExpenditure: { value: 0, unit: "usd_micros" },
    maxModelParameterCount: { value: parameters, unit: "parameters" },
    resetPeriod: null,
    expiresAt: null,
  };
}

describe("budgets", () => {
  it("rejects negative quantities", () => {
    const parsed = resourceBudgetSchema.safeParse({
      ...budget(1),
      maxCpuAllocation: { value: -1, unit: "millicores" },
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects an agent budget above the department budget", () => {
    expect(() =>
      assertAgentBudgetWithinDepartment(
        budget(20),
        { maxModelParameterCount: { value: 0, unit: "parameters" } },
        budget(10),
      ),
    ).toThrow(DomainError);
  });

  it("accepts an agent budget equal to the department budget", () => {
    expect(() =>
      assertAgentBudgetWithinDepartment(
        budget(10, 5),
        { maxModelParameterCount: { value: 5, unit: "parameters" } },
        budget(10, 5),
      ),
    ).not.toThrow();
  });

  it("rejects a parameter budget that disagrees with the compute budget", () => {
    expect(() =>
      assertParameterBudgetMatchesCompute(budget(1, 5), {
        maxModelParameterCount: { value: 4, unit: "parameters" },
      }),
    ).toThrow(DomainError);
  });

  it("does not claim cloud enforcement", () => {
    expect(BUDGET_ENFORCEMENT_SCOPE).toBe("definition-and-validation-only");
  });
});
