import "dotenv/config";
import { hostname } from "node:os";
import type { Message } from "@ai-colony/contracts";
import { Authorizer, MessagingService, ObjectiveService } from "@ai-colony/core";
import { createDatabase, createPersistence } from "@ai-colony/database";
import { loadInferenceConfig, OpenAICompatibleProvider, routeFromConfig } from "@ai-colony/inference";
import { loadWorkerConfig, RabbitMessageTransport, runMessageConsumer } from "@ai-colony/messaging";
import { openCheckpointer } from "./checkpoint.js";
import { compileCeoGraph, compileMonitoringGraph, compileOrchestrationGraph } from "./graphs.js";
import { objectiveMessageHandler } from "./runtime.js";
import { loop, runCeoPass, runMonitoringPass, runOrchestrationPass } from "./worker.js";

const role = process.argv[2];
if (role !== "ceo" && role !== "orchestration" && role !== "specialist" && role !== "monitoring") {
  process.stderr.write("Usage: worker <ceo|orchestration|specialist|monitoring>\n");
  process.exit(1);
}

const messaging = loadWorkerConfig(process.env);
const inference = loadInferenceConfig(process.env);
const route = routeFromConfig(inference);
const policy = {
  ...messaging.policy,
  leaseMs: Math.max(messaging.policy.leaseMs, inference.timeoutMs + 30_000),
};
const { db, close } = createDatabase(messaging.databaseUrl);
const persistence = createPersistence(db, close);
const provider = new OpenAICompatibleProvider({
  baseUrl: inference.baseUrl,
  apiKey: inference.apiKey,
  maxConcurrency: inference.maxConcurrency,
  transportRetries: inference.transportRetries,
});
const workerId = `${role}:${hostname()}:${process.pid}`;
const controller = new AbortController();
process.on("SIGTERM", () => controller.abort());
process.on("SIGINT", () => controller.abort());

const checkpointer = await openCheckpointer(messaging.databaseUrl);
const runtime: { service?: ObjectiveService } = {};
const messages = new MessagingService(
  persistence,
  new Authorizer(),
  policy,
  role === "specialist" || role === "orchestration"
    ? (message: Message) => {
        if (!runtime.service) {
          throw new Error("Workflow service is not ready");
        }
        return objectiveMessageHandler({
          service: runtime.service,
          provider,
          route,
          workerId,
          role,
        })(message);
      }
    : undefined,
);
const service = new ObjectiveService(persistence, new Authorizer(), messages);
runtime.service = service;

try {
  if (role === "ceo") {
    const graph = compileCeoGraph({ service, provider, route, workerId, checkpointer });
    await loop(controller.signal, 2000, async () => {
      await service.heartbeat(workerId, role, null);
      await runCeoPass(graph, service);
    });
  } else if (role === "orchestration") {
    const graph = compileOrchestrationGraph({ service, route, workerId, checkpointer });
    const transport = new RabbitMessageTransport(messaging.rabbitUrl, policy.prefetch);
    await Promise.all([
      loop(controller.signal, 2000, async () => {
        await service.heartbeat(workerId, role, null);
        await runOrchestrationPass(graph, new Date().toISOString());
      }),
      runMessageConsumer({
        persistence,
        transport,
        service: messages,
        workerId,
        policy,
        signal: controller.signal,
        departmentIds: () => service.orchestrationDepartment().then((id) => (id ? [id] : [])),
      }),
    ]);
  } else if (role === "specialist") {
    const transport = new RabbitMessageTransport(messaging.rabbitUrl, policy.prefetch);
    await runMessageConsumer({
      persistence,
      transport,
      service: messages,
      workerId,
      policy,
      signal: controller.signal,
      departmentIds: async () => {
        await service.heartbeat(workerId, role, null);
        return service.specialistDepartments();
      },
    });
  } else {
    const graph = compileMonitoringGraph({
      service,
      staleAfterMs: Number(process.env.RUNTIME_STALE_AFTER_MS ?? 30_000),
      allowRecovery: process.env.MONITORING_ALLOW_RECOVERY === "true",
      checkpointer,
    });
    await loop(controller.signal, 5000, async () => {
      await service.heartbeat(workerId, role, "inference-configured");
      await runMonitoringPass(graph, new Date().toISOString());
    });
  }
} finally {
  await checkpointer.end();
  await close();
}
