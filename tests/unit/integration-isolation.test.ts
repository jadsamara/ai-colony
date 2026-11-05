import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assertIsolatedCompose,
  assertIntegrationDatabaseTarget,
  resolveIntegrationDatabaseUrl,
  resolveIntegrationRabbitUrl,
} from "../helpers/isolation.js";

const disposable = "postgres://m101:m101@127.0.0.1:5435/colony_m101_integration";

describe("integration harness isolation", () => {
  it("rejects canonical port 5433 without connecting", () => {
    expect(() => assertIntegrationDatabaseTarget("postgres://m101:m101@127.0.0.1:5433/colony_m101_integration")).toThrow(/5433/);
  });

  it("rejects protected port 5434 without connecting", () => {
    expect(() => assertIntegrationDatabaseTarget("postgres://m101:m101@127.0.0.1:5434/colony_m101_integration")).toThrow(/5434/);
  });

  it("rejects the canonical database name without connecting", () => {
    expect(() => assertIntegrationDatabaseTarget("postgres://m101:m101@127.0.0.1:5435/ai_colony")).toThrow(/canonical or unrecognized database name/);
  });

  it("rejects a missing disposable URL and ignores DATABASE_URL from .env", () => {
    expect(() => resolveIntegrationDatabaseUrl({ DATABASE_URL: "postgres://colony:colony@127.0.0.1:5433/ai_colony" })).toThrow(/INTEGRATION_DATABASE_URL/);
    expect(resolveIntegrationDatabaseUrl({
      DATABASE_URL: "postgres://colony:colony@127.0.0.1:5433/ai_colony",
      INTEGRATION_DATABASE_URL: disposable,
    })).toBe(disposable);
  });

  it("rejects the canonical data directory and an unrecognized endpoint", () => {
    expect(() => assertIntegrationDatabaseTarget("postgres://m101:m101@127.0.0.1:5435/colony_m101_integration?options=/tmp/ai-colony-pg")).toThrow(/canonical data directory/);
    expect(() => assertIntegrationDatabaseTarget("postgres://m101:m101@example.com:5435/colony_m101_integration")).toThrow(/Unrecognized database endpoint/);
    expect(() => assertIntegrationDatabaseTarget("postgres://m101:m101@127.0.0.1:5432/colony_m101_integration")).toThrow(/5432/);
  });

  it("rejects a Compose file that points at production infrastructure", () => {
    const production = readFileSync("docker-compose.yml", "utf8");
    const isolated = readFileSync("docker-compose.integration.yml", "utf8");
    expect(() => assertIsolatedCompose(production)).toThrow(/canonical|production/);
    expect(() => assertIsolatedCompose(isolated)).not.toThrow();
  });

  it("rejects the production RabbitMQ port and inherited RABBITMQ_URL", () => {
    expect(() => resolveIntegrationRabbitUrl({ RABBITMQ_URL: "amqp://colony:colony@127.0.0.1:5672" })).toThrow(/INTEGRATION_RABBITMQ_URL/);
    expect(() => resolveIntegrationRabbitUrl({ INTEGRATION_RABBITMQ_URL: "amqp://m101:m101@127.0.0.1:5672" })).toThrow(/production RabbitMQ/);
  });
});
