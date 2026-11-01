import { randomUUID } from "node:crypto";
import { ZodError } from "zod";
import type { FastifyError, FastifyInstance } from "fastify";
import { DomainError } from "@ai-colony/core";

interface ValidationIssue {
  path: string;
  message: string;
}

export function registerErrors(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) => {
    return reply.status(404).send({
      error: {
        code: "NOT_FOUND",
        message: `No route for ${request.method} ${request.url.split("?")[0] ?? request.url}`,
        correlationId: request.correlationId || randomUUID(),
      },
    });
  });

  app.setErrorHandler((error, request, reply) => {
    const correlationId = request.correlationId || randomUUID();
    if (error instanceof DomainError) {
      return reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
          correlationId,
        },
      });
    }
    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "Request validation failed",
          details: { issues: zodIssues(error) },
          correlationId,
        },
      });
    }
    const fastifyError = error as FastifyError;
    if (fastifyError.validation) {
      return reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "Request validation failed",
          details: {
            issues: fastifyError.validation.map((issue) => ({
              path: issue.instancePath || issue.schemaPath || "",
              message: issue.message ?? "Invalid value",
            })),
          },
          correlationId,
        },
      });
    }
    if (fastifyError.statusCode && fastifyError.statusCode < 500) {
      return reply.status(fastifyError.statusCode).send({
        error: {
          code: fastifyError.code ?? "BAD_REQUEST",
          message: fastifyError.message,
          correlationId,
        },
      });
    }
    request.log.error({ err: error }, "unhandled error");
    return reply.status(500).send({
      error: {
        code: "INTERNAL_ERROR",
        message: "Internal server error",
        correlationId,
      },
    });
  });
}

function zodIssues(error: ZodError): ValidationIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
  }));
}
