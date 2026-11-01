import type { InferenceProvider, InferenceRoute, ObjectiveService } from "@ai-colony/core";
import type { CeoGraph, MonitoringGraph, OrchestrationGraph } from "./graphs.js";

export async function runCeoPass(graph: CeoGraph, service: ObjectiveService): Promise<number> {
  const ids = await service.activeIds();
  for (const objectiveId of ids) {
    await graph.invoke(
      { objectiveId, status: "run" },
      { configurable: { thread_id: `ceo:${objectiveId}` }, recursionLimit: 8 },
    );
  }
  return ids.length;
}

export async function runOrchestrationPass(graph: OrchestrationGraph, tick: string): Promise<void> {
  await graph.invoke(
    { objectiveId: "orchestration", status: "run" },
    { configurable: { thread_id: `orchestration:${tick}` }, recursionLimit: 4 },
  );
}

export async function runMonitoringPass(graph: MonitoringGraph, tick: string): Promise<void> {
  await graph.invoke(
    { objectiveId: "monitoring", status: "run" },
    { configurable: { thread_id: `monitoring:${tick}` }, recursionLimit: 4 },
  );
}

export async function loop(signal: AbortSignal, pollMs: number, work: () => Promise<void>): Promise<void> {
  while (!signal.aborted) {
    await work();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, pollMs);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }
}

export type { InferenceProvider, InferenceRoute };
