import { z } from "zod";

export const ROUTING_METHODS = ["deterministic", "model_assisted", "fallback"] as const;
export type RoutingMethod = (typeof ROUTING_METHODS)[number];

export const ROUTING_CONFIDENCE = ["high", "medium", "low"] as const;
export type RoutingConfidence = (typeof ROUTING_CONFIDENCE)[number];

export const orchestrationRouteSchema = z
  .object({
    primarySlug: z.string().trim().min(1).max(64),
    additionalSlugs: z.array(z.string().trim().min(1).max(64)).max(10).default([]),
    rationale: z.string().trim().min(1).max(1_000),
    confidence: z.enum(ROUTING_CONFIDENCE),
    approvalRequired: z.boolean().default(false),
  })
  .strict();

export type OrchestrationRouteDraft = z.infer<typeof orchestrationRouteSchema>;

export const ORCHESTRATION_ROUTE_SCHEMA = [
  "Return one JSON object and no other text.",
  'Required schema: {"primarySlug":"string","additionalSlugs":["string"],"rationale":"string","confidence":"high"|"medium"|"low","approvalRequired":boolean}.',
  "primarySlug must be one of the available department slugs.",
  "additionalSlugs must be a subset of available department slugs and must not repeat primarySlug.",
  "Select only departments that are needed. Prefer the smallest set that can answer the task.",
  "Do not invent departments. Do not grant permissions. Do not request training, promotion, or department creation.",
].join(" ");

/** Unambiguous arithmetic only — not multidisciplinary math+science wording. */
const PURE_ARITHMETIC =
  /^\s*(?:(?:what(?:'s| is)|calculate|compute|evaluate)\s+)?(-?\d+(?:\.\d+)?)\s*([+\-*/×÷])\s*(-?\d+(?:\.\d+)?)\s*\??\s*$/i;

export interface AvailableDepartment {
  id: string;
  slug: string;
  name: string;
  status: string;
}

export interface DeterministicRouteHit {
  primarySlug: string;
  additionalSlugs: string[];
  rationale: string;
  confidence: RoutingConfidence;
}

/**
 * Deterministic routing for genuinely unambiguous requests only.
 * Complex or multidisciplinary wording returns null so Orchestration can decide.
 */
export function tryDeterministicDepartmentRoute(task: string): DeterministicRouteHit | null {
  const text = task.trim();
  if (!text || text.length > 280) {
    return null;
  }
  if (PURE_ARITHMETIC.test(text)) {
    return {
      primarySlug: "math",
      additionalSlugs: [],
      rationale: "The request is a closed arithmetic expression that Math can answer alone.",
      confidence: "high",
    };
  }
  return null;
}

export interface RejectedRecommendation {
  slug: string;
  reason: string;
}

export function validateRoutedDepartments(input: {
  primarySlug: string;
  additionalSlugs: readonly string[];
  available: readonly AvailableDepartment[];
  maxParticipants: number;
  excludeDepartmentId?: string | null;
}): {
  primary: AvailableDepartment;
  additional: AvailableDepartment[];
  rejected: RejectedRecommendation[];
  finalIds: string[];
} {
  const bySlug = new Map(input.available.filter((row) => row.status === "active").map((row) => [row.slug, row]));
  const rejected: RejectedRecommendation[] = [];
  const seen = new Set<string>();

  const take = (slug: string): AvailableDepartment | null => {
    const normalized = slug.trim().toLowerCase();
    if (seen.has(normalized)) {
      rejected.push({ slug: normalized, reason: "duplicate" });
      return null;
    }
    const row = bySlug.get(normalized);
    if (!row) {
      const inactive = input.available.find((item) => item.slug === normalized);
      rejected.push({
        slug: normalized,
        reason: inactive ? `department is ${inactive.status}` : "unknown or unauthorized department",
      });
      return null;
    }
    if (input.excludeDepartmentId && row.id === input.excludeDepartmentId) {
      rejected.push({ slug: normalized, reason: "opener department cannot be selected as a routed participant" });
      return null;
    }
    seen.add(normalized);
    return row;
  };

  let primary = take(input.primarySlug);
  const additional: AvailableDepartment[] = [];
  for (const slug of input.additionalSlugs) {
    const row = take(slug);
    if (row) {
      additional.push(row);
    }
  }

  // Opener cannot be the recipient. Promote the next recommended specialist, or a facilitator.
  if (!primary) {
    const promoted = additional.shift();
    if (promoted) {
      primary = promoted;
      rejected.push({
        slug: input.primarySlug.trim().toLowerCase(),
        reason: "primary was the opener; promoted the next recommended department",
      });
    } else {
      const facilitator = take("orchestration") ?? take("research") ?? take("reasoning");
      if (!facilitator) {
        throw new Error(
          `Primary department '${input.primarySlug}' is not selectable and no alternate participant is available`,
        );
      }
      primary = facilitator;
      rejected.push({
        slug: input.primarySlug.trim().toLowerCase(),
        reason: "primary was the opener; seated a facilitator because no other specialist was recommended",
      });
    }
  }

  // opener + primary + additional must fit the participant budget
  const capacity = Math.max(0, input.maxParticipants - 2);
  const capped = additional.slice(0, capacity);
  for (const dropped of additional.slice(capacity)) {
    rejected.push({ slug: dropped.slug, reason: "exceeded participant budget" });
  }

  return {
    primary,
    additional: capped,
    rejected,
    finalIds: [primary.id, ...capped.map((row) => row.id)],
  };
}

/** Build a routing idempotency key that always fits the 8–128 character contract. */
export function routingIdempotencyKey(preferred: string | undefined, openKey: string): string {
  if (preferred && /^[A-Za-z0-9_.:-]{8,128}$/.test(preferred)) {
    return preferred;
  }
  const prefix = "route:";
  const max = 128 - prefix.length;
  const body = openKey.slice(0, Math.max(8, max));
  const key = `${prefix}${body}`;
  return key.length >= 8 ? key.slice(0, 128) : `${key}________`.slice(0, 8);
}

export function boundedFallbackDepartments(task: string, available: readonly AvailableDepartment[]): DeterministicRouteHit {
  const active = new Set(available.filter((row) => row.status === "active").map((row) => row.slug));
  const text = task.toLowerCase();
  const picks: string[] = [];
  const add = (slug: string) => {
    if (active.has(slug) && !picks.includes(slug)) {
      picks.push(slug);
    }
  };

  if (/\b(algebra|equation|calculate|compute|arithmetic|derivative|integral|mathematics|mathematical)\b/.test(text)) {
    add("math");
  }
  if (/\b(physics|gravitational|biology|chemistry|hypothesis|experiment)\b/.test(text)) {
    add("science");
  }
  if (/\b(literature|citation|evidence|research)\b/.test(text)) {
    add("research");
  }
  if (/\b(logic|premise|contradiction|reasoning)\b/.test(text)) {
    add("reasoning");
  }
  if (/\b(benchmark|evaluation|metric|performance)\b/.test(text)) {
    add("evaluation");
  }
  if (/\b(memory|forgetting|retention)\b/.test(text)) {
    add("memory-and-forgetting");
  }
  if (/\b(weight|adapter|lora|training|finetune)\b/.test(text)) {
    add("weight-optimization");
  }
  if (/\b(product|user experience|improvement proposal)\b/.test(text)) {
    add("product");
  }

  if (picks.length === 0) {
    add("research");
  }
  if (!picks.length) {
    const any = available.find((row) => row.status === "active");
    if (!any) {
      throw new Error("No active departments are available for fallback routing");
    }
    return {
      primarySlug: any.slug,
      additionalSlugs: [],
      rationale: "Fallback selected the only available active department after Orchestration inference failed.",
      confidence: "low",
    };
  }

  return {
    primarySlug: picks[0]!,
    additionalSlugs: picks.slice(1, 3),
    rationale:
      "Orchestration inference failed. A bounded keyword fallback selected specialists; this is not a model decision.",
    confidence: "low",
  };
}
