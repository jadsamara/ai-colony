import "dotenv/config";
import { createDatabase } from "./client.js";
import { migrateDatabase } from "./migrate.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const { db, close } = createDatabase(databaseUrl);
try {
  await migrateDatabase(db);
  console.log("Migrations applied");
} finally {
  await close();
}
