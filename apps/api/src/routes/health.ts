import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { healthResponseSchema } from "@ai-colony/contracts";

export async function registerHealthRoutes(
  app: FastifyInstance,
  checkReady: () => Promise<boolean>,
): Promise<void> {
  const route = app.withTypeProvider<ZodTypeProvider>();
  const schema = {
    tags: ["health"],
    security: [] as [],
    response: {
      200: healthResponseSchema,
      503: healthResponseSchema,
    },
  };

  const health = async () => ({ status: "ok" as const, service: "ai-colony-api" as const });

  const ready = async (_request: FastifyRequest, reply: FastifyReply) => {
    const ok = await checkReady();
    return reply.status(ok ? 200 : 503).send({
      status: ok ? "ok" : "degraded",
      service: "ai-colony-api",
      checks: { database: ok ? "ok" : "down" },
    });
  };

  route.get("/health", { schema }, health);
  route.get("/ready", { schema }, ready);
  route.get("/api/v1/health", { schema }, health);
  route.get("/api/v1/ready", { schema }, ready);
}
