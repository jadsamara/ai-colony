import { describe, expect, it } from "vitest";
import type { Actor, RoleName } from "@ai-colony/contracts";
import { ROLE_NAMES } from "@ai-colony/contracts";
import {
  assertCanAssignRole,
  assertCanCreateAgentWithRole,
  assertCanDecideApproval,
  assertNotSelfBudgetChange,
  Authorizer,
  DomainError,
  PERMISSIONS,
  permissionsForRole,
  ROLE_PERMISSIONS,
} from "@ai-colony/core";

function actor(role: RoleName, overrides: Partial<Actor> = {}): Actor {
  return {
    principalId: "00000000-0000-4000-8000-0000000000aa",
    principalType: role === "system_administrator" ? "system" : "agent",
    role,
    agentId: role === "system_administrator" ? null : "00000000-0000-4000-8000-0000000000bb",
    departmentId: role === "system_administrator" ? null : "00000000-0000-4000-8000-0000000000cc",
    permissions: permissionsForRole(role),
    ...overrides,
  };
}

describe("authorization", () => {
  const authorizer = new Authorizer();

  it("denies by default", () => {
    expect(() => authorizer.assert(actor("department_agent"), "department:create")).toThrow(
      DomainError,
    );
    expect(() => authorizer.assert(actor("read_only_observer"), "agent:create")).toThrow(
      DomainError,
    );
  });

  it("gives the system administrator every permission and nobody else permanent approval", () => {
    expect(permissionsForRole("system_administrator")).toEqual([...PERMISSIONS].sort());
    for (const role of ROLE_NAMES) {
      if (role === "system_administrator") {
        expect(ROLE_PERMISSIONS[role].has("approval:decide:permanent")).toBe(true);
      } else {
        expect(ROLE_PERMISSIONS[role].has("approval:decide:permanent")).toBe(false);
      }
    }
  });

  it("does not treat a CEO as a system administrator", () => {
    expect(ROLE_PERMISSIONS.ceo_agent.has("agent:assign-role")).toBe(false);
    expect(() =>
      assertCanDecideApproval(
        actor("ceo_agent"),
        { requestedBy: "other", approvalType: "department_activate" },
        "specialized",
      ),
    ).toThrowError(/not a system administrator/);
  });

  it("blocks self approval, self budget changes, and role escalation", () => {
    const ceo = actor("ceo_agent");
    expect(() =>
      assertCanDecideApproval(
        ceo,
        { requestedBy: ceo.principalId, approvalType: "department_create" },
        "temporary",
      ),
    ).toThrowError(/cannot decide/);
    expect(() =>
      assertNotSelfBudgetChange(ceo, { targetType: "agent", targetId: ceo.agentId ?? "" }),
    ).toThrow(DomainError);
    expect(() => assertCanCreateAgentWithRole(ceo, "ceo_agent")).toThrow(DomainError);
    expect(() =>
      assertCanCreateAgentWithRole(actor("system_administrator"), "system_administrator"),
    ).toThrow(DomainError);
    expect(() => assertCanAssignRole(ceo, ceo.agentId ?? "", "department_agent")).toThrow(
      DomainError,
    );
  });

  it("lets the bootstrap administrator decide a request they created", () => {
    const admin = actor("system_administrator", {
      principalId: "00000000-0000-4000-8000-000000000001",
      agentId: null,
      departmentId: null,
    });
    expect(() =>
      assertCanDecideApproval(
        admin,
        { requestedBy: admin.principalId, approvalType: "department_activate" },
        "system",
      ),
    ).not.toThrow();
  });
});
