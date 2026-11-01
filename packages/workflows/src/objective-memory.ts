import type { Actor } from "@ai-colony/contracts";
import { permissionsForRole, renderMemoryBlock, type MemoryService, type ObjectiveMemory, type Persistence } from "@ai-colony/core";

export function createObjectiveMemory(persistence: Persistence, memories: MemoryService): ObjectiveMemory {
  return {
    async contextFor(input) {
      const actor = await actorFor(persistence, input.purpose, input.objectiveId, input.taskId);
      if (!actor) {
        return "";
      }
      const result = await memories.retrieveRelevantMemories(
        { actor, correlationId: input.objectiveId },
        { query: input.query, objectiveId: input.objectiveId, taskId: input.taskId },
      );
      return renderMemoryBlock(result.hits);
    },
    async capture(input) {
      const actor = await actorFor(persistence, input.purpose, input.objectiveId, input.taskId);
      if (!actor?.agentId || !actor.departmentId) {
        return;
      }
      const kind = input.purpose === "correct" ? "plan" : input.purpose;
      await memories.createMemory(
        { actor, correlationId: input.objectiveId },
        {
          scope: "agent",
          category: kind === "synthesize" ? "semantic" : "episodic",
          ownerAgentId: actor.agentId,
          departmentId: actor.departmentId,
          title: kind,
          summary: input.text.slice(0, 500),
          content: `Provenance: model_generated. This is an illustrative model output, not an externally verified measurement.\n\n${input.text}`.slice(0, 8000),
          provenance: "model_generated",
          idempotencyKey: kind === "specialist" && input.taskId ? `experience:${input.objectiveId}:task:${input.taskId}` : `experience:${input.objectiveId}:${kind}`,
          objectiveId: input.objectiveId,
          taskId: input.taskId ?? undefined,
        },
      );
    },
  };
}

async function actorFor(
  persistence: Persistence,
  purpose: string,
  objectiveId: string,
  taskId: string | null,
): Promise<Actor | null> {
  if (purpose === "specialist" && taskId) {
    const tasks = await persistence.repos.objectives.listTasks(objectiveId);
    const task = tasks.find((item) => item.id === taskId);
    if (!task?.assignedAgentId) {
      return null;
    }
    const agent = await persistence.repos.agents.findById(task.assignedAgentId);
    if (!agent) {
      return null;
    }
    return {
      principalId: agent.id,
      principalType: "agent",
      role: agent.role,
      agentId: agent.id,
      departmentId: agent.departmentId,
      permissions: permissionsForRole(agent.role),
    };
  }
  const ceo = await persistence.repos.memories.findAgentByRole("ceo_agent");
  if (!ceo) {
    return null;
  }
  return {
    principalId: ceo.id,
    principalType: "agent",
    role: "ceo_agent",
    agentId: ceo.id,
    departmentId: ceo.departmentId,
    permissions: permissionsForRole("ceo_agent"),
  };
}
