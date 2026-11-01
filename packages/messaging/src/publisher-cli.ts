import "dotenv/config";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { createDatabase, createPersistence } from "@ai-colony/database";
import { loadWorkerConfig } from "./config.js";
import { runOutboxPublisher } from "./publisher.js";
import { RabbitMessageTransport } from "./rabbitmq-transport.js";

const config = loadWorkerConfig(process.env);
const { db, close } = createDatabase(config.databaseUrl);
const persistence = createPersistence(db, close);
const transport = new RabbitMessageTransport(config.rabbitUrl, config.policy.prefetch);
const controller = new AbortController();
const workerId = `publisher:${hostname()}:${process.pid}:${randomUUID()}`;

process.on("SIGTERM", () => controller.abort());
process.on("SIGINT", () => controller.abort());

try {
  await runOutboxPublisher({
    persistence,
    transport,
    workerId,
    policy: config.policy,
    signal: controller.signal,
  });
  await close();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "publisher failed"}\n`);
  await close();
  process.exit(1);
}
