import { assertNoHierarchyCycle } from "../departments/hierarchy.js";
import { DomainError } from "../errors/domain-error.js";
import type { LedgerEdge, TaxonomyNode, TaxonomyNodeInput } from "./types.js";

export function validateTaxonomyGraph(nodes: readonly TaxonomyNodeInput[], knownTopicIds: ReadonlySet<string>): void {
  if (nodes.length === 0) {
    throw new DomainError("VALIDATION_ERROR", "A taxonomy version needs at least one topic", 422);
  }
  const ids = new Set<string>();
  for (const node of nodes) {
    if (ids.has(node.topicId)) {
      throw new DomainError("VALIDATION_ERROR", "A topic can appear once in a taxonomy version", 422, { topicId: node.topicId });
    }
    ids.add(node.topicId);
    if (!node.name.trim()) {
      throw new DomainError("VALIDATION_ERROR", "A topic needs a name", 422, { topicId: node.topicId });
    }
  }
  for (const node of nodes) {
    if (node.parentTopicId !== null && !ids.has(node.parentTopicId)) {
      throw new DomainError("VALIDATION_ERROR", "The parent topic is not in this taxonomy version", 422, {
        topicId: node.topicId,
        parentTopicId: node.parentTopicId,
      });
    }
    const ancestors: string[] = [];
    const seen = new Set<string>();
    let current = node.parentTopicId;
    while (current) {
      if (seen.has(current)) {
        assertNoHierarchyCycle(node.topicId, [node.topicId]);
      }
      seen.add(current);
      ancestors.push(current);
      current = nodes.find((candidate) => candidate.topicId === current)?.parentTopicId ?? null;
    }
    assertNoHierarchyCycle(node.topicId, ancestors);
    for (const link of node.crossLinks) {
      if (link === node.topicId) {
        throw new DomainError("VALIDATION_ERROR", "A topic cannot cross-link to itself", 422, { topicId: node.topicId });
      }
      if (!ids.has(link) && !knownTopicIds.has(link)) {
        throw new DomainError("VALIDATION_ERROR", "The cross-link target does not exist", 422, { topicId: node.topicId, link });
      }
    }
  }
}

export function reconstructTaxonomy(edges: readonly LedgerEdge[]): TaxonomyNode[] {
  const parents = edges.filter((edge) => edge.kind === "parent");
  const links = edges.filter((edge) => edge.kind === "cross_link");
  return parents
    .map((edge) => ({
      topicId: edge.topicId,
      parentTopicId: edge.parentTopicId,
      name: edge.name,
      description: edge.description,
      status: edge.status,
      crossLinks: links
        .filter((link) => link.topicId === edge.topicId && link.parentTopicId)
        .map((link) => ({
          topicId: link.parentTopicId as string,
          departmentId: link.targetDepartmentId,
          grantsMemoryAccess: false as const,
        })),
    }))
    .sort((left, right) => (left.topicId < right.topicId ? -1 : left.topicId > right.topicId ? 1 : 0));
}
