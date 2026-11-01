import "dotenv/config";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { Authorizer, MessagingService } from "@ai-colony/core";
import { createDatabase, createPersistence } from "@ai-colony/database";
import { loadWorkerConfig } from "./config.js";
import { runMessageConsumer } from "./consumer.js";
import { RabbitMessageTransport } from "./rabbitmq-transport.js";

const config = loadWorkerConfig(process.env);
const { db, close } = createDatabase(config.databaseUrl);
const persistence = createPersistence(db, close);
const service = new MessagingService(persistence, new Authorizer(), config.policy);
const transport = new RabbitMessageTransport(config.rabbitUrl, config.policy.prefetch);
const controller = new AbortController();
const workerId = `consumer:${hostname()}:${process.pid}:${randomUUID()}`;

process.on("SIGTERM", () => controller.abort());
process.on("SIGINT", () => controller.abort());

try {
  await runMessageConsumer({
    persistence,
    transport,
    service,
    workerId,
    policy: config.policy,
    signal: controller.signal,
  });
  await close();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "consumer failed"}\n`);
  await close();
  process.exit(1);
}
