import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import { MessageHandlingError, type InferenceProvider, type InferenceRoute, type ObjectiveService } from "@ai-colony/core";
import { executePrepared } from "./runtime.js";

const WorkflowState = Annotation.Root({
  objectiveId: Annotation<string>({ reducer: (_left, right) => right, default: () => "" }),
  status: Annotation<"run" | "wait" | "done">({ reducer: (_left, right) => right, default: () => "run" }),
});

export function compileCeoGraph(input: {
  service: ObjectiveService;
  provider: InferenceProvider;
  route: InferenceRoute;
  workerId: string;
  checkpointer: BaseCheckpointSaver;
}) {
  return new StateGraph(WorkflowState)
    .addNode("ceo", async (state) => {
      try {
        const prepared = await input.service.prepareCeo(state.objectiveId, input.route, input.workerId);
        if (prepared.action !== "generate") {
          return { status: prepared.action };
        }
        await executePrepared(input.service, input.provider, prepared, input.route);
        return { status: "run" as const };
      } catch (error) {
        if (error instanceof MessageHandlingError && !error.permanent) {
          return { status: "wait" as const };
        }
        throw error;
      }
    })
    .addEdge(START, "ceo")
    .addConditionalEdges("ceo", (state) => (state.status === "run" ? "ceo" : END))
    .compile({ checkpointer: input.checkpointer });
}

export function compileOrchestrationGraph(input: {
  service: ObjectiveService;
  route: InferenceRoute;
  workerId: string;
  checkpointer: BaseCheckpointSaver;
}) {
  return new StateGraph(WorkflowState)
    .addNode("orchestrate", async () => {
      await input.service.schedule(input.route, input.workerId);
      return { status: "done" as const };
    })
    .addEdge(START, "orchestrate")
    .addEdge("orchestrate", END)
    .compile({ checkpointer: input.checkpointer });
}

export function compileMonitoringGraph(input: {
  service: ObjectiveService;
  staleAfterMs: number;
  allowRecovery: boolean;
  checkpointer: BaseCheckpointSaver;
}) {
  return new StateGraph(WorkflowState)
    .addNode("monitor", async () => {
      const overview = await input.service.overview(
        {
          actor: {
            principalId: "system:workflow",
            principalType: "system",
            role: "monitoring_agent",
            agentId: null,
            departmentId: null,
            permissions: [],
          },
          correlationId: "monitoring",
        },
        input.staleAfterMs,
      );
      for (const finding of overview.findings) {
        if (finding.severity === "info") {
          continue;
        }
        await input.service.alert(finding, null);
      }
      if (input.allowRecovery) {
        await input.service.schedule(
          {
            memoryProfile: "shared",
            alias: "recovery",
            operationalAlias: null,
            temperature: 0,
            maxOutputTokens: 1,
            timeoutMs: 1000,
            rates: { inputUsdPerMillion: null, outputUsdPerMillion: null },
            globalConcurrency: 1,
            departmentConcurrency: 1,
          },
          "monitoring-recovery",
        );
      }
      return { status: "done" as const };
    })
    .addEdge(START, "monitor")
    .addEdge("monitor", END)
    .compile({ checkpointer: input.checkpointer });
}

export type CeoGraph = ReturnType<typeof compileCeoGraph>;
export type OrchestrationGraph = ReturnType<typeof compileOrchestrationGraph>;
export type MonitoringGraph = ReturnType<typeof compileMonitoringGraph>;
