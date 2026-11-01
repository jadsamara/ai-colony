import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";

const CORRELATION_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export function registerCorrelation(app: FastifyInstance): void {
  app.addHook("onRequest", async (request) => {
    const incoming = request.headers["x-correlation-id"];
    const raw = Array.isArray(incoming) ? incoming[0] : incoming;
    request.correlationId = raw && CORRELATION_PATTERN.test(raw) ? raw : randomUUID();
  });

  app.addHook("onSend", async (request, reply) => {
    if (request.correlationId) {
      reply.header("x-correlation-id", request.correlationId);
    }
  });
}
