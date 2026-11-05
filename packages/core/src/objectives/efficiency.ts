import type { ObjectivePlan, ObjectivePerformance, TaskType } from "@ai-colony/contracts";
import type { InferenceObservation, MessageTiming, ObjectiveRun, ObjectiveTaskRecord } from "../ports/repositories.js";

export type ExecutionPath = "direct" | "lightweight" | "full";

export interface EfficiencyRoute {
  path: ExecutionPath;
  departments: TaskType[];
  rationale: string;
  skipCeoPlanning: boolean;
  skipCeoSynthesis: boolean;
}

const SPECIALIST_ORDER: readonly TaskType[] = ["math", "science", "research", "reasoning"];

const OPEN_OR_GOVERNED =
  /\b(compare|comparison|trade-?offs?|design|investigate|approve|approval|deploy|delete|grant|permission|permissions|budget|promote|secret|credential|drop)\b/i;

const MATH_SIGNAL =
  /\b(calculate|compute|multiply|multiplied|multiplication|divide|divided|division|plus|minus|sum|product|percent|percentage|average|times)\b|\d+(?:\.\d+)?\s*(?:x|×|\*|\/|\+|−|-|times|plus|minus|divided(?:\s+by)?|multiplied(?:\s+by)?)\s*\d+(?:\.\d+)?/i;

const SCIENCE_SIGNAL = /\b(hypothesis|experiment|molecule|physics|biology|chemical|temperature|boil(?:ing)?)\b/i;

const RESEARCH_SIGNAL = /\b(citations?|literature|peer-reviewed|evidence review|primary sources?)\b/i;

const REASONING_SIGNAL = /\b(contradict(?:ion|s|ory)?|syllogism|premise|logically|if and only if)\b/i;

const EXPECTED_OUTPUT: Record<TaskType, string> = {
  math: "The numerical result and a brief explanation.",
  science: "A direct scientific judgment.",
  research: "The evidence limit, labeled as model knowledge.",
  reasoning: "A direct assessment of the argument.",
};

export function routeObjective(objective: string): EfficiencyRoute {
  const text = objective.trim();
  if (text.length === 0 || text.length > 1500) {
    return full("The objective is empty or too broad for a deterministic route.");
  }
  if (OPEN_OR_GOVERNED.test(text)) {
    return full("The wording asks for comparison, design, investigation, or a governed action, so the CEO plans it.");
  }
  const departments = specialistSignals(text);
  if (departments.length === 0) {
    return full("No closed specialist capability is explicit, so the CEO plans it.");
  }
  if (departments.length > 2) {
    return full("More than two specialist capabilities are required, so the CEO plans the dependencies.");
  }
  if (departments.length === 2) {
    if (/\bor\b/i.test(text) && !/\band\b/i.test(text)) {
      return full("The wording leaves the specialist choice open, so the CEO plans it.");
    }
    return {
      path: "lightweight",
      departments,
      rationale: `The wording asks for ${departments[0]} and ${departments[1]} without an open comparison or a governed action.`,
      skipCeoPlanning: true,
      skipCeoSynthesis: true,
    };
  }
  const only = departments[0]!;
  if (only === "math" && !/\d/.test(text)) {
    return full("Math is mentioned without a concrete quantity, so the CEO plans it.");
  }
  return {
    path: "direct",
    departments: [only],
    rationale: `The objective is a closed ${only} request that one department can answer.`,
    skipCeoPlanning: true,
    skipCeoSynthesis: true,
  };
}

export function efficiencyPlan(objective: string, decision: EfficiencyRoute): ObjectivePlan {
  if (decision.path === "full" || decision.departments.length === 0) {
    throw new Error("A full route has no deterministic plan");
  }
  return {
    summary: decision.rationale,
    tasks: decision.departments.map((slug) => ({
      localId: slug,
      departmentSlug: slug,
      taskType: slug,
      objective: objective.trim(),
      expectedOutput: EXPECTED_OUTPUT[slug],
      dependsOn: [],
    })),
    completionCriteria: ["Each selected specialist has returned a result."],
    estimatedResources: { inferenceRequests: decision.departments.length, outputTokens: 256 },
    risks: ["A deterministic route does not expand the objective if the wording omitted a real requirement."],
  };
}

export function buildPerformance(input: {
  run: Pick<
    ObjectiveRun,
    | "id"
    | "createdAt"
    | "startedAt"
    | "completedAt"
    | "planningCompletedAt"
    | "synthesisStartedAt"
    | "executionPath"
    | "executionRationale"
  >;
  tasks: Array<
    Pick<
      ObjectiveTaskRecord,
      "id" | "departmentSlug" | "dependsOn" | "createdAt" | "startedAt" | "completedAt" | "requestMessageId"
    >
  >;
  inferences: InferenceObservation[];
  messages: MessageTiming[];
}): ObjectivePerformance {
  const tasksById = new Map(input.tasks.map((task) => [task.id, task]));
  const messagesById = new Map(input.messages.map((message) => [message.id, message]));
  const departmentByTask = new Map(input.tasks.map((task) => [task.id, task.departmentSlug]));
  const taskRows = input.tasks.map((task) => {
    const dependencyWaitMs = dependencyWait(task, tasksById);
    const gpuSamples = input.inferences.filter(
      (row) => row.taskId === task.id && row.purpose === "specialist" && row.latencyMs !== null,
    );
    const timing = task.requestMessageId ? messagesById.get(task.requestMessageId) : undefined;
    return {
      taskId: task.id,
      departmentSlug: task.departmentSlug,
      queueWaitMs: queueWait(task, dependencyWaitMs),
      dependencyWaitMs,
      executionMs: elapsed(task.startedAt, task.completedAt),
      gpuInferenceMs: gpuSamples.length > 0 ? gpuSamples.reduce((sum, row) => sum + (row.latencyMs ?? 0), 0) : null,
      messageDeliveryMs: timing ? elapsed(timing.createdAt, timing.deliveredAt) : null,
    };
  });
  const inferences = input.inferences.map((row) => ({
    id: row.id,
    taskId: row.taskId,
    purpose: row.purpose,
    departmentSlug: departmentFor(row, departmentByTask),
    status: row.status,
    gpuLatencyMs: row.latencyMs,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    tokenSource: row.tokenSource,
  }));
  const tokens = tokenTotals(input.inferences);
  return {
    objectiveId: input.run.id,
    executionPath: input.run.executionPath,
    rationale: input.run.executionRationale,
    endToEndMs: elapsed(input.run.createdAt, input.run.completedAt),
    planningMs: elapsed(input.run.startedAt, input.run.planningCompletedAt),
    planningGpuMs: purposeGpu(input.inferences, ["plan", "correct"]),
    inferenceRequestCount: input.inferences.length,
    inputTokens: tokens.inputTokens,
    outputTokens: tokens.outputTokens,
    tokenAccounting: tokens.tokenAccounting,
    unavailableTokenRequests: tokens.unavailableTokenRequests,
    specialistGpuMs: purposeGpu(input.inferences, ["specialist"]),
    synthesisMs: elapsed(input.run.synthesisStartedAt, input.run.completedAt),
    synthesisGpuMs: purposeGpu(input.inferences, ["synthesize"]),
    tasks: taskRows,
    inferences,
    departments: departmentRollup(taskRows, inferences),
  };
}

function full(rationale: string): EfficiencyRoute {
  return {
    path: "full",
    departments: [],
    rationale,
    skipCeoPlanning: false,
    skipCeoSynthesis: false,
  };
}

function specialistSignals(text: string): TaskType[] {
  const present = new Set<TaskType>();
  if (MATH_SIGNAL.test(text)) {
    present.add("math");
  }
  if (SCIENCE_SIGNAL.test(text)) {
    present.add("science");
  }
  if (RESEARCH_SIGNAL.test(text)) {
    present.add("research");
  }
  if (REASONING_SIGNAL.test(text)) {
    present.add("reasoning");
  }
  return SPECIALIST_ORDER.filter((slug) => present.has(slug));
}

function elapsed(start: string | null, end: string | null): number | null {
  if (!start || !end) {
    return null;
  }
  const value = Date.parse(end) - Date.parse(start);
  return Number.isFinite(value) ? Math.max(0, value) : null;
}

function dependencyWait(
  task: Pick<ObjectiveTaskRecord, "dependsOn" | "createdAt">,
  tasksById: Map<string, Pick<ObjectiveTaskRecord, "completedAt">>,
): number | null {
  if (task.dependsOn.length === 0) {
    return 0;
  }
  const completions: number[] = [];
  for (const id of task.dependsOn) {
    const dependency = tasksById.get(id);
    if (!dependency?.completedAt) {
      return null;
    }
    completions.push(Date.parse(dependency.completedAt));
  }
  const latest = Math.max(...completions);
  return Math.max(0, latest - Date.parse(task.createdAt));
}

function queueWait(
  task: Pick<ObjectiveTaskRecord, "createdAt" | "startedAt">,
  dependencyWaitMs: number | null,
): number | null {
  if (!task.startedAt || dependencyWaitMs === null) {
    return null;
  }
  const readyAt = Date.parse(task.createdAt) + dependencyWaitMs;
  return Math.max(0, Date.parse(task.startedAt) - readyAt);
}

function purposeGpu(rows: InferenceObservation[], purposes: string[]): number | null {
  const samples = rows.filter((row) => purposes.includes(row.purpose) && row.latencyMs !== null);
  if (samples.length === 0) {
    return null;
  }
  return samples.reduce((sum, row) => sum + (row.latencyMs ?? 0), 0);
}

function departmentFor(row: InferenceObservation, departmentByTask: Map<string, string>): string {
  if (row.taskId) {
    return departmentByTask.get(row.taskId) ?? "unattributed";
  }
  if (row.purpose === "plan" || row.purpose === "correct" || row.purpose === "synthesize" || row.purpose === "monitor") {
    return "ceo";
  }
  return "unattributed";
}

function tokenTotals(rows: InferenceObservation[]): {
  inputTokens: number | null;
  outputTokens: number | null;
  tokenAccounting: ObjectivePerformance["tokenAccounting"];
  unavailableTokenRequests: number;
} {
  const known = rows.filter((row) => row.inputTokens !== null && row.outputTokens !== null && row.tokenSource !== null);
  const unavailableTokenRequests = rows.length - known.length;
  if (rows.length === 0 || known.length === 0) {
    return { inputTokens: null, outputTokens: null, tokenAccounting: "unavailable", unavailableTokenRequests: rows.length };
  }
  const inputTokens = known.reduce((sum, row) => sum + (row.inputTokens ?? 0), 0);
  const outputTokens = known.reduce((sum, row) => sum + (row.outputTokens ?? 0), 0);
  const tokenAccounting =
    unavailableTokenRequests === 0 && known.every((row) => row.tokenSource === "observed") ? "observed" : "partial";
  return { inputTokens, outputTokens, tokenAccounting, unavailableTokenRequests };
}

function departmentRollup(
  tasks: ObjectivePerformance["tasks"],
  inferences: ObjectivePerformance["inferences"],
): ObjectivePerformance["departments"] {
  const buckets = new Map<
    string,
    { taskCount: number; inferenceRequestCount: number; gpu: number[]; execution: number[] }
  >();
  const bucket = (slug: string) => {
    const existing = buckets.get(slug);
    if (existing) {
      return existing;
    }
    const created = { taskCount: 0, inferenceRequestCount: 0, gpu: [], execution: [] };
    buckets.set(slug, created);
    return created;
  };
  for (const task of tasks) {
    const row = bucket(task.departmentSlug);
    row.taskCount += 1;
    if (task.executionMs !== null) {
      row.execution.push(task.executionMs);
    }
  }
  for (const inference of inferences) {
    const row = bucket(inference.departmentSlug);
    row.inferenceRequestCount += 1;
    if (inference.gpuLatencyMs !== null) {
      row.gpu.push(inference.gpuLatencyMs);
    }
  }
  return [...buckets.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([departmentSlug, row]) => ({
      departmentSlug,
      taskCount: row.taskCount,
      inferenceRequestCount: row.inferenceRequestCount,
      gpuInferenceMs: row.gpu.length > 0 ? row.gpu.reduce((sum, value) => sum + value, 0) : null,
      executionMs: row.execution.length > 0 ? row.execution.reduce((sum, value) => sum + value, 0) : null,
    }));
}
