import { dedicatedInstanceId } from "../serving/endpoints.js";

/** Stable Product identities. These are not Gaming's department, agent, or instance ids. */
export const PRODUCT_DEPARTMENT_ID = "00000000-0000-4000-8000-00000000001d";
export const PRODUCT_AGENT_ID = "00000000-0000-4000-8000-000000000213";
export const PRODUCT_SERVING_INSTANCE_ID = dedicatedInstanceId(PRODUCT_DEPARTMENT_ID);
export const GAMING_DEPARTMENT_ID = "00000000-0000-4000-8000-00000000001c";
export const GAMING_AGENT_ID = "00000000-0000-4000-8000-000000000212";
export const GAMING_SERVING_INSTANCE_ID = dedicatedInstanceId(GAMING_DEPARTMENT_ID);
export const EVALUATION_DEPARTMENT_ID = "00000000-0000-4000-8000-000000000017";
export const PRODUCT_ENDPOINT_REFERENCE = "serving://product";
export const GAMING_ENDPOINT_REFERENCE = "serving://gaming";
export const PRODUCT_REAL_ENDPOINT = "http://ollama-product:11434";
export const PRODUCT_MOCK_ENDPOINT = "http://mock-product:8080";
export const PRODUCT_MODEL_VERSION = "qwen3-8b-base-v1";

/**
 * End state of the seeded inventory. Gaming stays in the seed so its history
 * remains addressable, and it is not an active department.
 */
export function inventoryDepartmentStatus(slug: string): "active" | "archived" {
  return slug === "gaming" ? "archived" : "active";
}
