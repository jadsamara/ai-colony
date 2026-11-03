import { QWEN3_8B_MODEL_ID } from "@ai-colony/contracts";

/**
 * Seeded departments that existed before M10 and may use the shared Qwen3-8B
 * compatibility route when they have no active assignment.
 * The proposed API department `engineering` is intentionally absent.
 */
export const LEGACY_DEPARTMENT_IDS = [
  "00000000-0000-4000-8000-000000000011",
  "00000000-0000-4000-8000-000000000012",
  "00000000-0000-4000-8000-000000000013",
  "00000000-0000-4000-8000-000000000014",
  "00000000-0000-4000-8000-000000000015",
  "00000000-0000-4000-8000-000000000016",
  "00000000-0000-4000-8000-000000000017",
  "00000000-0000-4000-8000-000000000018",
  "00000000-0000-4000-8000-000000000019",
  "00000000-0000-4000-8000-00000000001a",
  "00000000-0000-4000-8000-00000000001b",
  "00000000-0000-4000-8000-00000000001c",
] as const;

export const LEGACY_ROUTING_POLICY_VERSION = "m10-legacy-shared-qwen3-8b-v1";
export const SHARED_QWEN3_8B_MODEL_ID = QWEN3_8B_MODEL_ID;
export const ROUTING_EVIDENCE_TTL_MS = 30_000;
export const CEO_DEPARTMENT_ID = "00000000-0000-4000-8000-000000000011";

const LEGACY_DEPARTMENT_SET = new Set<string>(LEGACY_DEPARTMENT_IDS);

export function isLegacyDepartment(departmentId: string): boolean {
  return LEGACY_DEPARTMENT_SET.has(departmentId);
}
