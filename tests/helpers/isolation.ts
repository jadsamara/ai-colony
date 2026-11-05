const CANONICAL_DATA_DIRECTORY = "/tmp/ai-colony-pg";
const CANONICAL_DATABASE_NAME = "ai_colony";

export function resolveIntegrationDatabaseUrl(env: NodeJS.ProcessEnv): string {
  const configured = env.INTEGRATION_DATABASE_URL?.trim();
  if (!configured) {
    throw new Error(
      "Missing explicit INTEGRATION_DATABASE_URL. Refusing DATABASE_URL inherited from the environment or .env.",
    );
  }
  assertIntegrationDatabaseTarget(configured);
  return configured;
}

export function maintenanceDatabaseUrl(databaseUrl: string): string {
  const parsed = new URL(databaseUrl);
  parsed.pathname = "/postgres";
  const maintenance = parsed.toString();
  assertIntegrationDatabaseTarget(maintenance, { allowMaintenanceDatabase: true });
  return maintenance;
}

export function resolveIntegrationRabbitUrl(env: NodeJS.ProcessEnv): string {
  const configured = env.INTEGRATION_RABBITMQ_URL?.trim();
  if (!configured) {
    throw new Error(
      "Missing explicit INTEGRATION_RABBITMQ_URL. Refusing RABBITMQ_URL inherited from the environment or .env.",
    );
  }
  const parsed = new URL(configured);
  if (parsed.protocol !== "amqp:" && parsed.protocol !== "amqps:") {
    throw new Error("Unrecognized RabbitMQ protocol");
  }
  if (!isLoopback(parsed.hostname)) {
    throw new Error("Unrecognized RabbitMQ host");
  }
  if (parsed.port === "5672" || parsed.port === "15672") {
    throw new Error("Refusing the production RabbitMQ port");
  }
  if (parsed.port !== "5673") {
    throw new Error("Unrecognized RabbitMQ endpoint");
  }
  return configured;
}

export function assertIntegrationDatabaseTarget(
  databaseUrl: string,
  options: { allowMaintenanceDatabase?: boolean } = {},
): void {
  if (databaseUrl.includes(CANONICAL_DATA_DIRECTORY)) {
    throw new Error("Refusing the canonical data directory");
  }
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("Unrecognized database endpoint");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("Unrecognized database endpoint");
  }
  if (!isLoopback(parsed.hostname)) {
    throw new Error("Unrecognized database endpoint");
  }
  if (parsed.port !== "5435") {
    throw new Error(`Refusing database port ${parsed.port || "default"}`);
  }
  const name = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!/^[a-z0-9_]+$/.test(name) || name === CANONICAL_DATABASE_NAME) {
    throw new Error("Refusing the canonical or unrecognized database name");
  }
  if (name !== "postgres" && options.allowMaintenanceDatabase) {
    throw new Error("Unrecognized database endpoint");
  }
  if (name === "postgres" && !options.allowMaintenanceDatabase) {
    throw new Error("Refusing a maintenance database as the test target");
  }
}

export function assertIsolatedCompose(text: string): void {
  if (text.includes(CANONICAL_DATA_DIRECTORY)) {
    throw new Error("Compose references the canonical data directory");
  }
  if (/POSTGRES_DB:\s*ai_colony\b|POSTGRES_DB:-ai_colony\b|POSTGRES_DB:\s*\$\{[^}]*:-ai_colony\}/.test(text)) {
    throw new Error("Compose uses the canonical database name");
  }
  if (text.includes("container_name: ai-colony-postgres") || text.includes("container_name: ai-colony-rabbitmq")) {
    throw new Error("Compose uses a production container name");
  }
  if (text.includes("ai_colony_postgres") || text.includes("ai_colony_rabbitmq")) {
    throw new Error("Compose uses a production volume");
  }
  if (/(?:^|[\s"'])(?:127\.0\.0\.1:)?(?:5433|5434|5672):/.test(text) || /:-5433\b|:-5434\b|:-5672\b/.test(text)) {
    throw new Error("Compose publishes a production port");
  }
  if (!text.includes("127.0.0.1:5435:5432")) {
    throw new Error("Compose does not bind the disposable PostgreSQL port");
  }
}

function isLoopback(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost";
}
