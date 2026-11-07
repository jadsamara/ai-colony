import {
  OBJECTIVE_HARD_CAPS,
  objectivePlanSchema,
  type ObjectivePlan,
  type PlanTask,
} from "@ai-colony/contracts";
import { parseModelJson, suspiciousMathControls } from "../autonomy/conversation-integrity.js";

export interface PlanContext {
  activeDepartmentSlugs: ReadonlySet<string>;
  staffedDepartmentSlugs: ReadonlySet<string>;
  maxInferenceRequests: number;
  maxOutputTokens: number;
}

export function extractJsonObject(text: string): unknown {
  try {
    const parsed = parseModelJson(text);
    if (stringHasSuspiciousMath(parsed.value)) {
      throw new Error("output contained a corrupted mathematical escape");
    }
    return parsed.value;
  } catch (error) {
    if (error instanceof Error && (error.message.includes("did not contain a JSON object") || error.message.includes("mathematical"))) {
      throw error;
    }
    throw new Error("output was not valid JSON");
  }
}

function stringHasSuspiciousMath(value: unknown): boolean {
  if (typeof value === "string") {
    return suspiciousMathControls(value);
  }
  if (Array.isArray(value)) {
    return value.some(stringHasSuspiciousMath);
  }
  if (value && typeof value === "object") {
    return Object.values(value).some(stringHasSuspiciousMath);
  }
  return false;
}

export function validatePlan(
  input: unknown,
  context: PlanContext,
): { plan: ObjectivePlan | null; errors: string[] } {
  const parsed = objectivePlanSchema.safeParse(input);
  if (!parsed.success) {
    return {
      plan: null,
      errors: parsed.error.issues.slice(0, 12).map((issue) => {
        const path = issue.path.join(".");
        return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
      }),
    };
  }
  const errors = planErrors(parsed.data, context);
  return errors.length > 0 ? { plan: null, errors } : { plan: parsed.data, errors: [] };
}

export function planErrors(plan: ObjectivePlan, context: PlanContext): string[] {
  const errors: string[] = [];
  if (plan.tasks.length > OBJECTIVE_HARD_CAPS.maxTasks) {
    errors.push(`A plan may contain at most ${OBJECTIVE_HARD_CAPS.maxTasks} tasks`);
  }
  const ids = new Set<string>();
  for (const task of plan.tasks) {
    if (ids.has(task.localId)) {
      errors.push(`Duplicate task id ${task.localId}`);
    }
    ids.add(task.localId);
    if (task.departmentSlug !== task.taskType) {
      errors.push(`Task ${task.localId} must be assigned to its own department`);
    }
    if (!context.activeDepartmentSlugs.has(task.departmentSlug)) {
      errors.push(`Department ${task.departmentSlug} is not an active registered department`);
    } else if (!context.staffedDepartmentSlugs.has(task.departmentSlug)) {
      errors.push(`Department ${task.departmentSlug} has no eligible agent`);
    }
    for (const dependency of task.dependsOn) {
      if (dependency === task.localId) {
        errors.push(`Task ${task.localId} depends on itself`);
      } else if (!plan.tasks.some((candidate) => candidate.localId === dependency)) {
        errors.push(`Task ${task.localId} depends on unknown task ${dependency}`);
      }
    }
  }
  errors.push(...cycleAndDepthErrors(plan.tasks));
  if (plan.estimatedResources.inferenceRequests > context.maxInferenceRequests) {
    errors.push("Estimated inference requests exceed the objective limit");
  }
  if (plan.estimatedResources.outputTokens > context.maxOutputTokens) {
    errors.push("Estimated output tokens exceed the objective limit");
  }
  return errors;
}

function cycleAndDepthErrors(tasks: readonly PlanTask[]): string[] {
  const errors: string[] = [];
  const deps = new Map(tasks.map((task) => [task.localId, task.dependsOn]));
  const memo = new Map<string, number>();
  const depthOf = (id: string, stack: string[]): number => {
    if (stack.includes(id)) {
      errors.push(`Task ${id} is part of a dependency cycle`);
      return 0;
    }
    const cached = memo.get(id);
    if (cached !== undefined) {
      return cached;
    }
    let depth = 0;
    for (const dependency of deps.get(id) ?? []) {
      if (deps.has(dependency)) {
        depth = Math.max(depth, 1 + depthOf(dependency, [...stack, id]));
      }
    }
    if (depth > OBJECTIVE_HARD_CAPS.maxDependencyDepth) {
      errors.push(`Task ${id} exceeds the dependency depth limit`);
    }
    memo.set(id, depth);
    return depth;
  };
  for (const task of tasks) {
    depthOf(task.localId, []);
  }
  return [...new Set(errors)];
}
