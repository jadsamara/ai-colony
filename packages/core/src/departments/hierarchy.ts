import { DomainError } from "../errors/domain-error.js";

export function assertNoHierarchyCycle(subjectId: string, ancestorIds: readonly string[]): void {
  if (ancestorIds.includes(subjectId)) {
    throw new DomainError(
      "HIERARCHY_CYCLE",
      "That parent would create a cycle in the hierarchy",
      409,
      { subjectId },
    );
  }
}
