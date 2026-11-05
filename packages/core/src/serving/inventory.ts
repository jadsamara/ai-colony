import { SHARED_QWEN3_8B_MODEL_ID } from "../routing/policy.js";
import { dedicatedInstanceId, endpointReferenceFor } from "./endpoints.js";
import type {
  AgentSource,
  DedicatedServingInstance,
  DepartmentProfile,
  DepartmentSource,
  ExecutionLimits,
} from "./types.js";

const LIMITS: ExecutionLimits = {
  maxSteps: 6,
  maxWallClockMs: 30_000,
  maxTokens: 2_048,
  maxToolCalls: 4,
  maxRetries: 1,
  maxConcurrentRequests: 1,
  dailyRequestLimit: 100,
};

const SPECIALIZATIONS: Record<string, { role: string; instructions: string; tools: string[]; collaborators: string[] }> = {
  ceo: {
    role: "ceo_agent",
    instructions: "Coordinate strategy and review department results. Do not approve your own requests or authorize a permanent department.",
    tools: ["review_result"],
    collaborators: ["orchestration", "monitoring"],
  },
  orchestration: {
    role: "orchestration_agent",
    instructions: "Decompose, schedule, and assemble authorized department work. Do not execute another department's model.",
    tools: ["schedule_task"],
    collaborators: ["math", "science", "reasoning", "research", "monitoring"],
  },
  monitoring: {
    role: "monitoring_agent",
    instructions: "Report health, budgets, and serving failures. Do not change a route or a budget.",
    tools: ["read_health"],
    collaborators: ["orchestration"],
  },
  evolution: {
    role: "evolution_agent",
    instructions: "Propose structural changes. Do not create or activate a department.",
    tools: ["propose_department"],
    collaborators: ["orchestration"],
  },
  "weight-optimization": {
    role: "department_agent",
    instructions: "Analyze training evidence and propose an adapter experiment. Do not train, promote, or replace production weights.",
    tools: ["propose_experiment"],
    collaborators: ["evaluation"],
  },
  "memory-and-forgetting": {
    role: "department_agent",
    instructions: "Propose retention, forgetting, and contradiction notes. Do not read another department's private memory or erase weights.",
    tools: ["propose_retention"],
    collaborators: ["orchestration"],
  },
  evaluation: {
    role: "department_agent",
    instructions: "Propose benchmark runs and regression notes. Do not publish a suite, decide a gate, or move a route.",
    tools: ["propose_benchmark"],
    collaborators: ["weight-optimization"],
  },
  research: {
    role: "department_agent",
    instructions: "Compare sources that are already in the task. Do not fetch the network or grant authority.",
    tools: ["compare_sources"],
    collaborators: ["reasoning"],
  },
  math: {
    role: "department_agent",
    instructions: "Do mathematical analysis and quantitative checks with authorized calculation tools.",
    tools: ["calculate"],
    collaborators: ["reasoning"],
  },
  reasoning: {
    role: "department_agent",
    instructions: "Decompose problems, detect contradictions, and verify a proposed solution.",
    tools: ["check_contradiction"],
    collaborators: ["math"],
  },
  science: {
    role: "department_agent",
    instructions: "Evaluate a hypothesis. Ask Math to check a quantity and Reasoning to review an argument when the task needs it.",
    tools: ["analyze_hypothesis"],
    collaborators: ["math", "reasoning"],
  },
  gaming: {
    role: "department_agent",
    instructions: "Play an authorized turn of a simulation. Do not reach outside the task state.",
    tools: ["simulate_turn"],
    collaborators: ["reasoning"],
  },
  product: {
    role: "department_agent",
    instructions:
      "Identify colony gaps from authorized evidence and propose a measured improvement. Select participants from the evidence. Do not approve your own proposal, create or activate a department, promote weights, deploy infrastructure, or mark an improvement successful without independent evaluation.",
    tools: ["propose_improvement", "select_participants", "request_evaluation"],
    collaborators: ["orchestration", "evaluation", "monitoring", "memory-and-forgetting"],
  },
};

export function departmentProfiles(
  departments: readonly DepartmentSource[],
  agents: readonly AgentSource[],
): DepartmentProfile[] {
  const active = departments.filter((department) => department.status === "active");
  return active.map((department) => {
    const agent = agents.find((candidate) => candidate.departmentId === department.id);
    if (!agent) {
      throw new Error(`Active department ${department.slug} has no agent identity`);
    }
    const specialization = SPECIALIZATIONS[department.slug] ?? {
      role: "department_agent",
      instructions: department.purpose,
      tools: [],
      collaborators: ["orchestration"],
    };
    return {
      departmentId: department.id,
      slug: department.slug,
      name: department.name,
      agentId: agent.id,
      role: specialization.role,
      instructions: specialization.instructions,
      tools: specialization.tools,
      collaborators: specialization.collaborators,
      memoryNamespace: `department:${department.slug}`,
      limits: LIMITS,
      modelRegistryId: SHARED_QWEN3_8B_MODEL_ID,
      modelVersion: "qwen3-8b-base-v1",
    };
  });
}

export function planDedicatedInstances(
  profiles: readonly DepartmentProfile[],
  status: DedicatedServingInstance["status"] = "configured",
): DedicatedServingInstance[] {
  return profiles.map((profile) => ({
    instanceId: dedicatedInstanceId(profile.departmentId),
    departmentId: profile.departmentId,
    agentId: profile.agentId,
    provider: "ollama",
    endpointReference: endpointReferenceFor(profile.slug),
    normalizedEndpoint: endpointReferenceFor(profile.slug),
    modelRegistryId: profile.modelRegistryId,
    modelVersion: profile.modelVersion,
    artifactDigest: null,
    deploymentMode: "dedicated",
    status,
    resourcePolicyId: `policy:${profile.slug}`,
  }));
}
