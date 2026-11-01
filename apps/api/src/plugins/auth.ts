import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { DomainError } from "@ai-colony/core";
import type { AppConfig } from "../config.js";

const PUBLIC_PATHS = new Set([
  "/health",
  "/ready",
  "/api/v1/health",
  "/api/v1/ready",
  "/api/v1/openapi.json",
]);

function isPublic(url: string): boolean {
  const path = url.split("?")[0] ?? url;
  if (PUBLIC_PATHS.has(path) || path === "/docs" || path.startsWith("/docs/")) {
    return true;
  }
  return false;
}

export function registerAuth(app: FastifyInstance, config: AppConfig): void {
  app.addHook("onRequest", async (request) => {
    if (isPublic(request.url)) {
      request.actor = null;
      return;
    }
    if (config.authMode !== "development") {
      throw new DomainError(
        "UNAUTHENTICATED",
        "This API does not accept development credentials in the current auth mode",
        401,
      );
    }
    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      throw new DomainError("UNAUTHENTICATED", "A bearer principal id is required", 401);
    }
    const token = header.slice("Bearer ".length).trim();
    if (!z.string().uuid().safeParse(token).success) {
      throw new DomainError(
        "UNAUTHENTICATED",
        "Development bearer tokens are principal UUIDs",
        401,
      );
    }
    const actor = await app.services.identity.getActor(token);
    if (!actor) {
      throw new DomainError("UNAUTHENTICATED", "Unknown principal", 401);
    }
    request.actor = actor;
  });
}
