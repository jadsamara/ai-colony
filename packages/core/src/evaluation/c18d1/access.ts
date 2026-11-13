/**
 * C1.8D.1 locked-benchmark access control (Evaluation-owned).
 * Item-level locked tests are never available to Math or Weight Optimization.
 */

export const C18D1_BENCHMARK_VERSION = "c18d1-algebra-v2" as const;
/** Locked splits under v1 were exposed in git and must never be used. */
export const C18D1_RETIRED_LOCKED_BENCHMARK_VERSION = "c18d1-algebra-v1" as const;
export const C18D1_EVALUATION_DEPARTMENT_ID = "00000000-0000-4000-8000-000000000017" as const;
export const C18D1_MATH_DEPARTMENT_ID = "00000000-0000-4000-8000-000000000019" as const;
export const C18D1_WEIGHT_DEPARTMENT_ID = "00000000-0000-4000-8000-000000000015" as const;

export type C18d1AccessRole =
  | "evaluation"
  | "math"
  | "weight_optimization"
  | "memory"
  | "monitoring"
  | "ceo"
  | "research"
  | "unknown";

const DEPARTMENT_ROLE: Record<string, C18d1AccessRole> = {
  [C18D1_EVALUATION_DEPARTMENT_ID]: "evaluation",
  [C18D1_MATH_DEPARTMENT_ID]: "math",
  [C18D1_WEIGHT_DEPARTMENT_ID]: "weight_optimization",
  "00000000-0000-4000-8000-000000000016": "memory",
};

export function resolveC18d1Role(input: {
  role?: string | null;
  departmentId?: string | null;
}): C18d1AccessRole {
  if (input.role) {
    const normalized = input.role.trim().toLowerCase().replace(/[-\s]/g, "_");
    if (
      normalized === "evaluation"
      || normalized === "math"
      || normalized === "weight_optimization"
      || normalized === "memory"
      || normalized === "monitoring"
      || normalized === "ceo"
      || normalized === "research"
    ) {
      return normalized;
    }
  }
  if (input.departmentId) {
    const mapped = DEPARTMENT_ROLE[input.departmentId];
    if (mapped) {
      return mapped;
    }
  }
  return "unknown";
}

export function canReadLockedMathItems(input: {
  role?: string | null;
  departmentId?: string | null;
}): boolean {
  return resolveC18d1Role(input) === "evaluation";
}

export function assertCanReadLockedMathItems(input: {
  role?: string | null;
  departmentId?: string | null;
}): void {
  if (!canReadLockedMathItems(input)) {
    throw new Error(
      "C1.8D.1 locked-test item-level artifacts are restricted to Evaluation. "
        + "Math/Weight may receive approved aggregate summaries only.",
    );
  }
}

export function canReadAggregateMathSummary(input: {
  role?: string | null;
  departmentId?: string | null;
}): boolean {
  const role = resolveC18d1Role(input);
  return role !== "unknown";
}

export function redactLockedItemFields<T extends Record<string, unknown>>(payload: T): Partial<T> {
  const blocked = new Set([
    "prompt",
    "expected",
    "rawPrediction",
    "predictions",
    "answer",
    "generatorSeed",
    "streamSeed",
    "contentDigest",
    "results",
  ]);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (!blocked.has(key)) {
      out[key] = value;
    }
  }
  return out as Partial<T>;
}

/** Autonomous Math training remains disabled during C1.8D.1 regardless of Phase 0. */
export const C18D1_AUTONOMOUS_MATH_TRAINING_ENABLED = false as const;

export const C18D1_RESIDUAL_ACCESS_LIMITATIONS = [
  "c18d1-algebra-v1 locked JSONL remains in git history; treat as burned — never evaluate or train on it.",
  "v2 locked JSONL must stay outside the repo under Evaluation host ACLs; application gates still required.",
  "Application-level gates must wrap every loader/API; prompt hiding alone is insufficient.",
] as const;
