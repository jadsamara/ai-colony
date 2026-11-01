import type { DepartmentStatus } from "@ai-colony/contracts";
import { DomainError } from "../errors/domain-error.js";

export const DEPARTMENT_TRANSITIONS: Record<DepartmentStatus, readonly DepartmentStatus[]> = {
  proposed: ["provisioning", "failed", "archived"],
  provisioning: ["active", "failed", "archived"],
  active: ["paused", "deprecated", "archived"],
  paused: ["active", "deprecated", "archived"],
  deprecated: ["archived"],
  failed: ["archived"],
  archived: [],
};

export function canTransitionDepartment(from: DepartmentStatus, to: DepartmentStatus): boolean {
  return DEPARTMENT_TRANSITIONS[from].includes(to);
}

export function assertDepartmentTransition(from: DepartmentStatus, to: DepartmentStatus): void {
  if (!canTransitionDepartment(from, to)) {
    throw new DomainError(
      "INVALID_TRANSITION",
      `Cannot transition department from ${from} to ${to}`,
      409,
      { from, to },
    );
  }
}

export function isPermanentDepartmentType(departmentType: string): boolean {
  return departmentType !== "temporary";
}
