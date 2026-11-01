import { describe, expect, it } from "vitest";
import { AGENT_STATUSES, DEPARTMENT_STATUSES } from "@ai-colony/contracts";
import {
  AGENT_TRANSITIONS,
  assertAgentTransition,
  assertDepartmentTransition,
  DEPARTMENT_TRANSITIONS,
  DomainError,
} from "@ai-colony/core";

describe("agent lifecycle", () => {
  it("accepts every documented transition and rejects the rest", () => {
    for (const from of AGENT_STATUSES) {
      for (const to of AGENT_STATUSES) {
        const allowed = DEPARTMENT_SAFE(from, to);
        if (allowed) {
          expect(() => assertAgentTransition(from, to, { authorizeRetry: true })).not.toThrow();
        } else {
          expect(() => assertAgentTransition(from, to, { authorizeRetry: true })).toThrow(
            DomainError,
          );
        }
      }
    }
  });

  it("requires explicit authorization to leave failed", () => {
    expect(() => assertAgentTransition("failed", "initializing")).toThrow(DomainError);
    try {
      assertAgentTransition("failed", "initializing");
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).code).toBe("RETRY_NOT_AUTHORIZED");
    }
    expect(() =>
      assertAgentTransition("failed", "initializing", { authorizeRetry: true }),
    ).not.toThrow();
  });
});

describe("department lifecycle", () => {
  it("accepts every documented transition and rejects the rest", () => {
    for (const from of DEPARTMENT_STATUSES) {
      for (const to of DEPARTMENT_STATUSES) {
        const allowed = DEPARTMENT_TRANSITIONS[from].includes(to);
        if (allowed) {
          expect(() => assertDepartmentTransition(from, to)).not.toThrow();
        } else {
          expect(() => assertDepartmentTransition(from, to)).toThrow(DomainError);
        }
      }
    }
  });
});

function DEPARTMENT_SAFE(
  from: (typeof AGENT_STATUSES)[number],
  to: (typeof AGENT_STATUSES)[number],
): boolean {
  return AGENT_TRANSITIONS[from].includes(to);
}
