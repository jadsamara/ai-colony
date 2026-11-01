import type { Actor } from "@ai-colony/contracts";

export interface RequestContext {
  actor: Actor;
  correlationId: string;
}

export function snapshot(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) {
    return null;
  }
  const encoded: unknown = JSON.parse(JSON.stringify(value));
  if (typeof encoded !== "object" || encoded === null || Array.isArray(encoded)) {
    throw new Error("Audit snapshots must be JSON objects");
  }
  return encoded as Record<string, unknown>;
}
