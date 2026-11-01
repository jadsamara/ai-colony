import "dotenv/config";
import { createDatabase, createPersistence } from "@ai-colony/database";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig(process.env);
const { db, close } = createDatabase(config.databaseUrl);
const persistence = createPersistence(db, close);
const app = await buildApp({ config, persistence });

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  app.log.info({ signal }, "shutting down");
  const force = setTimeout(() => {
    app.log.error("forced shutdown after timeout");
    process.exit(1);
  }, 10_000);
  force.unref();
  try {
    await app.close();
    await close();
    clearTimeout(force);
  } catch (error) {
    app.log.error({ err: error }, "shutdown failed");
    process.exit(1);
  }
}

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

try {
  await app.listen({ port: config.port, host: config.host });
  const database = new URL(config.databaseUrl);
  app.log.info(
    {
      authMode: config.authMode,
      authentication: config.authMode === "development" ? "development-bearer" : "fail-closed",
      nodeEnv: config.nodeEnv,
      databaseHost: database.host,
      databaseName: database.pathname,
    },
    "ai-colony api listening",
  );
} catch (error) {
  app.log.error({ err: error }, "server failed to start");
  await close();
  process.exit(1);
}
